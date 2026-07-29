"""Pre-split template matching for protected page bands."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from PIL import Image

from core.template_matching import (
    IgnoreRect,
    make_template_spec,
    match_template,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SuraHeaderSpec:
    top: int
    bottom: int
    score: float
    slot_count: int


class SuraHeaderLocator:
    """Locate sura headers before line splitting so cuts avoid them."""

    def __init__(
        self,
        template: Image.Image,
        *,
        ignore: IgnoreRect | None = None,
        slots: int = 1,
        threshold: float = 0.60,
        max_sura_headers: int = 3,
        prefer_acceleration: bool = True,
    ) -> None:
        self.max_sura_headers = max(1, max_sura_headers)
        self.header = make_template_spec(
            template,
            ignore,
            threshold,
            "sura_header",
            max(1, slots),
            prefer_acceleration=prefer_acceleration,
        )

    def locate(self, gray: np.ndarray) -> list[SuraHeaderSpec]:
        """Return sura headers in the coordinate space of *gray*."""
        spec = self.header
        match = match_template(gray, spec, crop_to_image_width=True)
        if match is None:
            logger.warning(
                "  Sura header template (%dx%d) does not fit the page (%dx%d) — no match attempted",
                spec.image.shape[1],
                spec.image.shape[0],
                gray.shape[1],
                gray.shape[0],
            )
            return []

        ys, xs = np.where(match >= spec.threshold)

        if ys.size == 0:
            # Nothing cleared the bar: report the best the page had to offer, so the
            # threshold can be chosen from evidence instead of guessed. The offset
            # counts matter too — a template nearly as wide as the page leaves very
            # few horizontal positions, and the true alignment may be out of reach.
            best_y, best_x = np.unravel_index(int(np.argmax(match)), match.shape)
            logger.warning(
                "  No sura header passed threshold %.4f — best score %.4f at y=%d x=%d "
                "(%d x %d candidate offsets)",
                spec.threshold,
                float(match[best_y, best_x]),
                int(best_y),
                int(best_x),
                match.shape[0],
                match.shape[1],
            )
            return []

        ordered = sorted(
            zip(xs.tolist(), ys.tolist(), strict=True),
            key=lambda xy: float(match[xy[1], xy[0]]),
            reverse=True,
        )
        template_h = spec.image.shape[0]
        min_gap = max(1, round(template_h * 1.75))

        selected: list[SuraHeaderSpec] = []
        for _x, y in ordered:
            score = float(match[y, _x])
            sura_header = SuraHeaderSpec(
                top=int(y),
                bottom=int(y + template_h),
                score=score,
                slot_count=spec.slot_count,
            )
            if any(abs(sura_header.top - existing.top) < min_gap for existing in selected):
                continue
            selected.append(sura_header)
            if len(selected) == self.max_sura_headers:
                break

        selected.sort(key=lambda sura_header: sura_header.top)
        for sura_header in selected:
            logger.info(
                "  Protected sura header band: y=%d..%d score=%.4f slots=%d",
                sura_header.top,
                sura_header.bottom,
                sura_header.score,
                sura_header.slot_count,
            )
        return selected

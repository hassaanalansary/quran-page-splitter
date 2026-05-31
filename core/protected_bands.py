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
class ProtectedBand:
    top: int
    bottom: int
    kind: str
    score: float
    slot_count: int


class ProtectedBandLocator:
    """Locate headers/basmala before line splitting so cuts avoid them."""

    def __init__(
        self,
        sura_header_template: Image.Image,
        *,
        sura_header_ignore: IgnoreRect | None = None,
        sura_header_slots: int = 1,
        sura_header_threshold: float = 0.60,
        max_sura_headers: int = 3,
        prefer_acceleration: bool = True,
    ) -> None:
        self.max_sura_headers = max(1, max_sura_headers)
        self.header = make_template_spec(
            sura_header_template,
            sura_header_ignore,
            sura_header_threshold,
            "sura_header",
            max(1, sura_header_slots),
            prefer_acceleration=prefer_acceleration,
        )

    def locate(self, gray: np.ndarray) -> list[ProtectedBand]:
        """Return protected bands in the coordinate space of *gray*."""
        spec = self.header
        match = match_template(gray, spec, crop_to_image_width=True)
        if match is None:
            return []

        ys, xs = np.where(match >= spec.threshold)

        if ys.size == 0:
            return []

        ordered = sorted(
            zip(xs.tolist(), ys.tolist(), strict=True),
            key=lambda xy: float(match[xy[1], xy[0]]),
            reverse=True,
        )
        template_h = spec.image.shape[0]
        min_gap = max(1, round(template_h * 0.75))

        selected: list[ProtectedBand] = []
        for _x, y in ordered:
            score = float(match[y, _x])
            band = ProtectedBand(
                top=int(y),
                bottom=int(y + template_h),
                kind=spec.kind,
                score=score,
                slot_count=spec.slot_count,
            )
            if any(abs(band.top - existing.top) < min_gap for existing in selected):
                continue
            selected.append(band)
            if len(selected) == self.max_sura_headers:
                break

        selected.sort(key=lambda band: band.top)
        for band in selected:
            logger.info(
                "  Protected %s band: y=%d..%d score=%.4f slots=%d",
                band.kind,
                band.top,
                band.bottom,
                band.score,
                band.slot_count,
            )
        return selected

"""Pre-split template matching for protected page bands."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IgnoreRect:
    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class ProtectedBand:
    top: int
    bottom: int
    kind: str
    score: float
    slot_count: int


@dataclass
class _TemplateSpec:
    image: np.ndarray
    mask: np.ndarray | None
    threshold: float
    kind: str
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
    ) -> None:
        self.max_sura_headers = max(1, max_sura_headers)
        self.header = self._prepare_spec(
            sura_header_template,
            sura_header_ignore,
            sura_header_threshold,
            "sura_header",
            max(1, sura_header_slots),
        )

    def locate(self, gray: np.ndarray) -> list[ProtectedBand]:
        """Return protected bands in the coordinate space of *gray*."""
        spec = self.header
        match = _match(gray, spec)
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

    @staticmethod
    def _prepare_spec(
        template: Image.Image,
        ignore: IgnoreRect | None,
        threshold: float,
        kind: str,
        slot_count: int,
    ) -> _TemplateSpec:
        image = np.array(template.convert("L"), dtype=np.uint8)
        mask = _make_mask(image.shape, ignore)
        return _TemplateSpec(
            image=image,
            mask=mask,
            threshold=threshold,
            kind=kind,
            slot_count=slot_count,
        )


def _make_mask(shape: tuple[int, int], ignore: IgnoreRect | None) -> np.ndarray | None:
    if ignore is None or ignore.w <= 0 or ignore.h <= 0:
        return None

    h, w = shape
    x1 = max(0, min(w, ignore.x))
    y1 = max(0, min(h, ignore.y))
    x2 = max(0, min(w, ignore.x + ignore.w))
    y2 = max(0, min(h, ignore.y + ignore.h))
    if x2 <= x1 or y2 <= y1:
        return None

    mask = np.full(shape, 255, dtype=np.uint8)
    mask[y1:y2, x1:x2] = 0
    if int(np.count_nonzero(mask)) == 0:
        return None
    return mask


def _match(gray: np.ndarray, spec: _TemplateSpec) -> np.ndarray | None:
    template_h, template_w = spec.image.shape
    image_h, image_w = gray.shape
    if image_h < template_h or image_w < template_w:
        spec.image = spec.image[:, 0:image_w]
        spec.mask = spec.mask[:, 0:image_w] if spec.mask is not None else None

    if spec.mask is None:
        result = cv2.matchTemplate(gray, spec.image, cv2.TM_CCOEFF_NORMED)
    else:
        result = cv2.matchTemplate(
            gray,
            spec.image,
            cv2.TM_CCOEFF_NORMED,
            mask=spec.mask,
        )
    return np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)

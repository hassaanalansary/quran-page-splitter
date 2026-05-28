"""Shared grayscale template matching helpers."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from core.opencv_accel import match_template_ccoeff_normed, upload_gray_for_matching


@dataclass(frozen=True)
class IgnoreRect:
    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class TemplateSpec:
    image: np.ndarray
    mask: np.ndarray | None
    threshold: float
    kind: str = ""
    slot_count: int = 1


def make_mask(shape: tuple[int, int], ignore: IgnoreRect | None) -> np.ndarray | None:
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


def make_template_spec(
    template: Image.Image,
    ignore: IgnoreRect | None,
    threshold: float,
    kind: str = "",
    slot_count: int = 1,
    *,
    prefer_acceleration: bool = True,
) -> TemplateSpec:
    image = np.array(template.convert("L"), dtype=np.uint8)
    mask = make_mask(image.shape, ignore)

    if mask is not None:
        if prefer_acceleration:
            # Due to the fact that openCL templateMatch doesn't support searching with mask
            # Fill ignored region with non-ignored mean, in order to use OpenCL kernel.
            mean_val = int(image[mask > 0].mean())
            filled = image.copy()
            filled[mask == 0] = mean_val
            return TemplateSpec(
                image=filled,
                mask=None,        # no mask → OpenCL path
                threshold=threshold,
                kind=kind,
                slot_count=slot_count,
            )
        else:
            # Keep the mask for CPU-based accurate matching
            return TemplateSpec(
                image=image,
                mask=mask,
                threshold=threshold,
                kind=kind,
                slot_count=slot_count,
            )

    return TemplateSpec(
        image=image,
        mask=None,
        threshold=threshold,
        kind=kind,
        slot_count=slot_count,
    )


def match_template(
    gray: np.ndarray,
    spec: TemplateSpec,
    *,
    crop_to_image_width: bool = False,
) -> np.ndarray | None:
    template_h, template_w = spec.image.shape
    image_h, image_w = gray.shape
    if image_h < template_h or image_w <= 0 or image_h <= 0:
        return None
    if image_w < template_w:
        if not crop_to_image_width:
            return None
        cropped = _crop_template_width(spec.image, spec.mask, image_w)
        if cropped is None:
            return None
        image, mask = cropped
    else:
        image, mask = spec.image, spec.mask

    prepared_gray = upload_gray_for_matching(gray)
    result = match_template_ccoeff_normed(prepared_gray, image, mask)
    return np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)


def locate_x_matches(
    gray: np.ndarray,
    spec: TemplateSpec,
    *,
    min_gap_ratio: float = 0.6,
    min_gap_px: int = 4,
) -> list[tuple[int, int]]:
    match = match_template(gray, spec)
    if match is None:
        return []

    scores = match.max(axis=0)
    if scores.size == 0 or float(scores.max()) < spec.threshold:
        return []

    candidate_x = np.where(scores >= spec.threshold)[0]
    if candidate_x.size == 0:
        return []

    by_score = sorted(
        candidate_x.tolist(),
        key=lambda x: float(scores[x]),
        reverse=True,
    )
    template_w = spec.image.shape[1]
    min_gap = max(min_gap_px, int(template_w * min_gap_ratio))
    selected: list[int] = []
    for x in by_score:
        if all(abs(x - existing) >= min_gap for existing in selected):
            selected.append(x)

    selected.sort()
    return [(x, x + template_w) for x in selected]


def _crop_template_width(
    image: np.ndarray,
    mask: np.ndarray | None,
    width: int,
) -> tuple[np.ndarray, np.ndarray | None] | None:
    cropped_image = image[:, :width]
    if mask is None:
        return cropped_image, None

    cropped_mask = mask[:, :width]
    if int(np.count_nonzero(cropped_mask)) == 0:
        return None
    return cropped_image, cropped_mask

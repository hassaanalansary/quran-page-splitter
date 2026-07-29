"""Shared grayscale template matching helpers."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from PIL import Image

from core.opencv_accel import (
    acceleration_is_opencl,
    match_template_ccoeff_normed,
    upload_gray_for_matching,
)

logger = logging.getLogger(__name__)

#: Ceiling on CPU re-scores per search. Verification runs only on candidates
#: that survive suppression, so this is never reached in normal use — it exists
#: so a pathological plateau of fabricated scores cannot stall a page.
MAX_VERIFICATIONS = 64


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
    #: Pin this template's matching to the CPU kernel for the whole run.
    force_cpu: bool = False


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

    # The setting picks the backend for this run, not merely how the ignored
    # region is handled — turning it off must actually stop OpenCL from
    # scoring, without an environment variable or a server restart.
    force_cpu = not prefer_acceleration

    if mask is not None and prefer_acceleration:
        # OpenCL's matchTemplate has no masked variant, so approximate the mask
        # by flattening the ignored region to the mean of what is kept. Costs
        # accuracy on genuine matches — the price of the OpenCL path.
        mean_val = int(image[mask > 0].mean())
        image = image.copy()
        image[mask == 0] = mean_val
        mask = None

    return TemplateSpec(
        image=image,
        mask=mask,
        threshold=threshold,
        kind=kind,
        slot_count=slot_count,
        force_cpu=force_cpu,
    )


def _effective_template(
    spec: TemplateSpec,
    gray_shape: tuple[int, int],
    crop_to_image_width: bool,
) -> tuple[np.ndarray, np.ndarray | None] | None:
    """The template as it will actually be applied to an image of *gray_shape*.

    Shared by the sweep and by verification, so a re-scored candidate is scored
    against exactly the template that produced the candidate in the first place.
    """
    template_h, template_w = spec.image.shape
    image_h, image_w = gray_shape
    if image_h < template_h or image_w <= 0 or image_h <= 0:
        return None
    if image_w >= template_w:
        return spec.image, spec.mask
    if not crop_to_image_width:
        return None
    return _crop_template_width(spec.image, spec.mask, image_w)


def match_template(
    gray: np.ndarray,
    spec: TemplateSpec,
    *,
    crop_to_image_width: bool = False,
) -> np.ndarray | None:
    resolved = _effective_template(spec, gray.shape, crop_to_image_width)
    if resolved is None:
        return None
    image, mask = resolved

    prepared_gray = upload_gray_for_matching(gray, force_cpu=spec.force_cpu)
    result = match_template_ccoeff_normed(prepared_gray, image, mask, force_cpu=spec.force_cpu)
    return np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)  # type: ignore[no-any-return]


def needs_cpu_verification(spec: TemplateSpec) -> bool:
    """Whether this spec's scores came from a kernel that has to be checked."""
    return not spec.force_cpu and acceleration_is_opencl()


def cpu_score_at(
    gray: np.ndarray,
    spec: TemplateSpec,
    x: int,
    y: int,
    *,
    crop_to_image_width: bool = False,
) -> float:
    """Re-score a single candidate position on the CPU kernel.

    OpenCV's OpenCL ``TM_CCOEFF_NORMED`` invents perfect scores at some
    positions: measured 1.0 against the CPU kernel's 0.0726 for the same page,
    template and row. Those fabrications outrank every genuine match, so a
    score-ordered shortlist is worthless unless its survivors are re-scored by
    the kernel that gets it right.

    Discarding "score == 1.0" would not work: a genuine match is also exactly
    1.0 when the template was cropped from the page being searched. Only
    recomputing tells the two apart.

    Costs one template-sized window per candidate, so it is affordable on the
    handful of positions that survive non-maximum suppression — never on the
    whole score map.
    """
    resolved = _effective_template(spec, gray.shape, crop_to_image_width)
    if resolved is None:
        return -1.0
    image, mask = resolved

    template_h, template_w = image.shape
    window = gray[y : y + template_h, x : x + template_w]
    if window.shape != (template_h, template_w):
        return -1.0

    result = match_template_ccoeff_normed(
        np.ascontiguousarray(window),
        image,
        mask,
        force_cpu=True,
    )
    return float(np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)[0, 0])


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

    # Verify before accepting, not after: a fabricated score that was allowed
    # into the shortlist would suppress the genuine separator beside it, and
    # dropping it later would take the real one down with it.
    verify = needs_cpu_verification(spec)
    best_row = match.argmax(axis=0) if verify else None
    budget = MAX_VERIFICATIONS

    selected: list[int] = []
    for x in by_score:
        if any(abs(x - existing) < min_gap for existing in selected):
            continue
        if verify and best_row is not None:
            if budget <= 0:
                logger.warning("    Verification budget spent; ignoring remaining separator candidates")
                break
            budget -= 1
            score = cpu_score_at(gray, spec, x, int(best_row[x]))
            if score < spec.threshold:
                logger.info(
                    "    Discarded phantom separator at x=%d (opencl %.4f → cpu %.4f)",
                    x,
                    float(scores[x]),
                    score,
                )
                continue
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

"""Line detection via valley-based splitting of horizontal projection profiles.

Finds the N-1 most prominent valleys in the row-sum profile to split
an image into exactly N lines.  No global threshold or minimum height
parameter is needed — the algorithm reads the answer directly from each
page's ink distribution.
"""

from __future__ import annotations

import numpy as np
from backend.core.image_utils import clean_image, find_content_bbox

_SMOOTHING_KERNEL_SIZE = 75


def _smooth(profile: np.ndarray) -> np.ndarray:
    """Apply a small moving-average to reduce single-row noise."""
    kernel = np.ones(_SMOOTHING_KERNEL_SIZE) / _SMOOTHING_KERNEL_SIZE
    return np.convolve(profile, kernel, mode="same")


def _find_local_minima(profile: np.ndarray) -> list[int]:
    """Return indices of all local minima (strict descent then ascent)."""
    diff = np.diff(profile)
    # A minimum at i means: diff[i-1] <= 0 (descending/flat) AND
    # diff[i] >= 0 (ascending/flat), with at least one strict inequality.
    descending = diff[:-1] <= 0
    ascending = diff[1:] >= 0
    strict = (diff[:-1] < 0) | (diff[1:] > 0)
    mask = descending & ascending & strict
    # Offset by 1 because diff shifts indices
    return (np.where(mask)[0] + 1).tolist()  # type: ignore[no-any-return]


def _compute_prominence(profile: np.ndarray, pos: int) -> float:
    """Topographic prominence: min(left wall, right wall) - valley depth."""
    val = profile[pos]

    # Scan left for the highest peak before a deeper valley or the edge
    left_max = val
    for j in range(pos - 1, -1, -1):
        if profile[j] < val:
            break
        left_max = max(left_max, float(profile[j]))

    # Scan right
    right_max = val
    for j in range(pos + 1, len(profile)):
        if profile[j] < val:
            break
        right_max = max(right_max, float(profile[j]))

    return float(min(left_max, right_max) - float(val))


def _select_valleys(
    positions: list[int],
    prominences: list[float],
    n: int,
    min_distance: int,
) -> list[int]:
    """Pick the *n* most prominent valleys, enforcing minimum separation."""
    order = sorted(
        range(len(positions)),
        key=lambda i: prominences[i],
        reverse=True,
    )
    selected: list[int] = []
    for idx in order:
        pos = positions[idx]
        if all(abs(pos - s) >= min_distance for s in selected):
            selected.append(pos)
            if len(selected) == n:
                break
    return sorted(selected)


def split_by_valleys(
    grey: np.ndarray,
    binary: np.ndarray,
    expected_lines: int,
    padding: int,
) -> list[dict[str, int]]:
    """Split an image into *expected_lines* line boxes by finding valleys.

    Internally calls ``clean_image`` to strip margins, then analyses
    the row-sum projection of the cleaned binary to locate the N-1 most
    prominent valleys.  Returns bounding boxes in the coordinate system
    of the **original** (pre-clean) arrays.

    Returns a list of dicts with keys: ``left``, ``top``, ``right``,
    ``bottom``.
    """
    if expected_lines < 1:
        return []

    _h_orig, w_orig = binary.shape

    # --- clean margins ---
    content = find_content_bbox(binary)
    if content is None:
        return []
    _cx, cy, _cw, ch = content
    _, clean_binary = clean_image(grey, binary)

    if expected_lines == 1:
        return [
            {
                "left": 0,
                "top": cy,
                "right": w_orig,
                "bottom": cy + ch,
            }
        ]

    # --- row-sum profile on clean binary ---
    row_sums = clean_binary.sum(axis=1).astype(np.float64)
    if float(row_sums.max()) <= 0:
        return []

    smoothed = _smooth(row_sums)

    # --- find and score valleys ---
    minima = _find_local_minima(smoothed)
    if not minima:
        return []

    prominences = [_compute_prominence(smoothed, p) for p in minima]

    # Minimum separation: half of nominal line height
    nominal_strip = ch / float(expected_lines)
    min_dist = max(1, round(nominal_strip * 0.8))

    n_needed = expected_lines - 1
    valleys = _select_valleys(minima, prominences, n_needed, min_dist)

    # --- map valleys back to original coordinates and build boxes ---
    # valleys are in clean_binary coordinates; add cy to get original coords
    splits = [cy] + [v + cy for v in valleys] + [cy + ch]

    boxes: list[dict[str, int]] = []
    for i in range(len(splits) - 1):
        boxes.append(
            {
                "left": 0,
                "top": splits[i],
                "right": w_orig,
                "bottom": splits[i + 1],
            }
        )

    return boxes

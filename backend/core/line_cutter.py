"""Line detection via valley-based splitting of horizontal projection profiles.

Finds the N-1 most prominent valleys in the row-sum profile to split
an image into exactly N lines.  No global threshold or minimum height
parameter is needed — the algorithm reads the answer directly from each
page's ink distribution.
"""

from __future__ import annotations

import numpy as np

from core.image_utils import clean_image, find_content_bbox

#: Moving-average width, as a fraction of one line's nominal height.
#:
#: Tuned by eye on a 300-dpi mushaf — wide enough to erase the small sharp peaks
#: inside a line, narrow enough to leave the trough between lines intact — where
#: it came to 75 px against a ~486 px line pitch. Kept as a ratio rather than
#: that pixel count because a page rendered four times smaller has a ~111 px
#: pitch, and 75 px there spans two thirds of a line: the inter-line gaps get
#: smoothed away, valleys drift toward whichever neighbour carries more ink, and
#: a low-ink line (a besmella) ends up with its neighbours' edges inside its box.
_SMOOTHING_RATIO = 0.155
_MIN_SMOOTHING_KERNEL = 3


def _smoothing_kernel_size(nominal_line_height: float) -> int:
    """Odd moving-average width for a page with this line pitch."""
    size = max(_MIN_SMOOTHING_KERNEL, round(nominal_line_height * _SMOOTHING_RATIO))
    return size + 1 if size % 2 == 0 else size


def _smooth(profile: np.ndarray, kernel_size: int) -> np.ndarray:
    """Apply a small moving-average to reduce single-row noise."""
    kernel = np.ones(kernel_size) / kernel_size
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

    # Both the smoothing width and the minimum valley separation scale with the
    # line pitch, so the same numbers hold whatever resolution the page was
    # rendered at.
    nominal_strip = ch / float(expected_lines)
    smoothed = _smooth(row_sums, _smoothing_kernel_size(nominal_strip))

    # --- find and score valleys ---
    minima = _find_local_minima(smoothed)
    if not minima:
        return []

    prominences = [_compute_prominence(smoothed, p) for p in minima]

    # Minimum separation: half of nominal line height
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

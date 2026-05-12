"""Line detection via horizontal projection profiles.

Uses row-sum analysis on a binarized image to find gaps between lines
and returns bounding boxes for each detected line.
"""

from __future__ import annotations

import numpy as np


def _text_bands_row_sums(
    binary: np.ndarray,
    gap_threshold: float,
) -> tuple[np.ndarray, float, float, list[tuple[int, int]]]:
    """Return row sums, peak, gap_limit, and raw text bands (y1, y2) before min_line_height."""
    h, w = binary.shape
    row_sums = binary.sum(axis=1)
    peak = float(row_sums.max())
    if peak <= 0:
        return row_sums, 0.0, 0.0, []
    gap_limit = peak * gap_threshold
    is_gap = row_sums < gap_limit

    in_text = False
    bands: list[tuple[int, int]] = []
    start = 0
    for y, gap in enumerate(is_gap):
        if not gap and not in_text:
            start = y
            in_text = True
        elif gap and in_text:
            bands.append((start, y))
            in_text = False
    if in_text:
        bands.append((start, len(is_gap)))

    return row_sums, peak, gap_limit, bands


def line_split_diagnostics(
    binary: np.ndarray,
    gap_threshold: float,
    min_line_height: int,
    padding: int,
) -> dict[str, float | int | list[int] | str]:
    """Explain how projection + min_line_height turned into N lines (for logging / JSON).

    ``min_line_height`` must match the value passed to ``get_line_boxes`` (often
    ``max(user_min, floor)`` from ``DetectionConfig.effective_min_line_height()``).
    """
    h, _w = binary.shape
    row_sums, peak, gap_limit, bands = _text_bands_row_sums(binary, gap_threshold)
    if peak <= 0:
        return {
            "crop_h": h,
            "interpretation": "Binary crop is empty (row sum peak is 0).",
            "raw_band_count": 0,
            "lines_after_min_height": 0,
        }

    is_gap = row_sums < gap_limit
    gap_rows = int(is_gap.sum())
    raw_heights = [y2 - y1 for y1, y2 in bands]
    dropped = sum(1 for rh in raw_heights if rh < min_line_height)
    kept = sum(1 for rh in raw_heights if rh >= min_line_height)

    # One band spanning most of the page → gap_threshold almost never marks gaps
    tallest = max(raw_heights) if raw_heights else 0
    merged_one_big_band = len(bands) == 1 and tallest >= int(h * 0.85)

    parts: list[str] = []
    parts.append(
        f"Projection: peak_row_sum={peak:.0f}, gap_limit=peak*gap_thr={gap_limit:.1f} "
        f"({100 * gap_rows / max(h, 1):.1f}% of rows marked as gap)."
    )
    parts.append(
        f"Bands: {len(bands)} raw contiguous text region(s); "
        f"{dropped} shorter than min_line_height={min_line_height}px (dropped); "
        f"{kept} kept as line(s)."
    )
    if merged_one_big_band and kept <= 2:
        parts.append(
            "Likely cause: gap_threshold is very low — almost no row counts as a gap, "
            "so the page merges into one tall band. Raise gap_threshold (e.g. try 0.02–0.05) "
            "or re-run calibration so gap_limit sits between inter-line valleys and ink peaks."
        )
    elif len(bands) >= 20 and kept < 5:
        parts.append(
            "Likely cause: many thin raw bands but min_line_height rejects most — "
            "min_line_height may be too high for this scan, or gap_threshold splits too finely."
        )

    return {
        "crop_h": h,
        "row_sum_peak": round(peak, 1),
        "gap_limit": round(gap_limit, 2),
        "gap_threshold": gap_threshold,
        "gap_row_count": gap_rows,
        "gap_row_fraction": round(gap_rows / max(h, 1), 4),
        "raw_band_count": len(bands),
        "raw_band_heights": raw_heights[:30],
        "bands_dropped_below_min_line_height": dropped,
        "lines_after_min_height": kept,
        "interpretation": " ".join(parts),
    }


def get_line_boxes(
    binary: np.ndarray,
    gap_threshold: float,
    min_line_height: int,
    padding: int,
) -> list[dict[str, int]]:
    """Detect text line bounding boxes from a binary image.

    Computes row sums, identifies gaps below the threshold, and returns
    bounding boxes for contiguous text bands that meet the minimum height.

    Returns a list of dicts with keys: left, top, right, bottom.
    Coordinates are relative to the input binary array.
    """
    h, w = binary.shape
    _row_sums, _peak, _gap_limit, bands = _text_bands_row_sums(binary, gap_threshold)

    boxes = []
    for y1, y2 in bands:
        if (y2 - y1) < min_line_height:
            continue
        boxes.append(
            {
                "left": 0,
                "top": max(0, y1 - padding),
                "right": w,
                "bottom": min(h, y2 + padding),
            }
        )

    return boxes

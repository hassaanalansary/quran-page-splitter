"""Line detection via horizontal projection profiles.

Uses row-sum analysis on a binarized image to find gaps between text lines
and returns bounding boxes for each detected line.
"""

import numpy as np


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

    # Calculate the sum of pixel values for each row
    row_sums = binary.sum(axis=1)
    # Calculate the threshold for detecting gaps between lines
    # by finding the row with highest sum of pixel values
    # (the text line with most black pixels) and multiplying it by
    # the gap threshold (3%) giving us what we consider as an empty row.
    gap_limit = row_sums.max() * gap_threshold
    # Detect gaps between lines by building a list of booleans indicating
    # whether a row is a gap or not.
    is_gap = row_sums < gap_limit

    # Find contiguous text bands
    # where each band is a tuple of (start, end)
    # indices of the rows that belong to the text.
    in_text = False
    bands = []
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

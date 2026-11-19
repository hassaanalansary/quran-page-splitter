"""Find the ink that reaches into a crop from beyond its top or bottom edge.

A line cut with room to breathe holds all of its own ink well inside its crop, so
a connected piece of ink touching the crop's top or bottom row belongs to a
neighbouring line, showing through. These functions find those pieces. Like the
rest of this package they know nothing of lines: hand them a crop and they answer
about the crop.

The left and right edges are not asked. The page column is cut tight to the text,
so the longest line's own first and last letters touch them.

The browser's Finalize canvas runs the same rule on the same rendered page, to
preview what an export will cut (``frontend/src/lib/edgeInk.ts``). A change here
must be made there too.
"""

import cv2
import numpy as np
from PIL import Image

#: A pixel is paper when R, G and B are all above this: the default
#: ``make_transparent`` cuts at, so the ink found is exactly the ink that shows.
PAPER_THRESHOLD = 200


def find_ink(crop: Image.Image, threshold: int = PAPER_THRESHOLD) -> np.ndarray:
    """A mask of the crop's ink: every pixel that is not paper."""
    rgb = np.asarray(crop.convert("RGB"))
    return np.asarray(~np.all(rgb > threshold, axis=2), dtype=bool)


def find_edge_ink(ink: np.ndarray) -> np.ndarray:
    """A mask of every 8-connected piece of ``ink`` that touches its top or bottom row."""
    if ink.size == 0:
        return np.zeros(ink.shape, dtype=bool)
    _count, labels = cv2.connectedComponents(ink.astype(np.uint8), connectivity=8)
    touching = np.union1d(labels[0], labels[-1])
    touching = touching[touching != 0]
    return np.isin(labels, touching)

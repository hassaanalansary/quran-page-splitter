"""Cut one blob of ink into pieces along lines a person drew: the knife.

Two letters printed touching are one connected blob, even across a word break: the
alef of ٱلَّذِى standing on the tip of the lam's bowl in كَمَثَلِ, say. A person draws a
short straight line, at any slope, across the place where they touch. The line only
separates. The pixels under it are taken out for a moment, the blob's remaining
pixels fall into pieces, and then the line is forgotten: only the pieces count.

The rule, step by step. ``frontend/src/lib/calibration/blobCuts.ts`` follows it pixel
for pixel, so change both together:

1. **Under a line**: an ink pixel whose centre is within ``CUT_RADIUS_SQUARED`` (as a
   squared distance) of the segment. The band is two pixels wide across, and no
   8-connected step can jump it.
2. **Pieces**: the 8-connected components of the ink that is left, numbered in raster
   order (row by row, left to right).
3. **Crumbs**: a component smaller than :func:`crumb_size` of the blob's ink is not a
   piece. A line drawn a little off can chip a few pixels away; they are given back
   like the line's own pixels.
4. **Order**: rightmost right edge first, since Arabic reads right to left and the
   earlier word's piece reaches further right. Ties go to the larger ``left + right``,
   then the higher top, then raster order.
5. **Give back**: the pixels under the lines and the crumbs' pixels join a piece one
   ring at a time. Each takes the piece of an 8-neighbour that was assigned before
   this ring, the lowest piece number on a tie. No ink is lost.

Everything is in the mask's own frame: integer columns and rows, with the lines given
in the same frame. All arithmetic is on integers, so both languages agree exactly.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

#: A pixel is under a line when its squared distance to the segment is at most this.
CUT_RADIUS_SQUARED = 1
#: A piece is a crumb below this many pixels whatever the blob's size...
CRUMB_MIN_PIXELS = 8
#: ...or below this fraction (1/n) of the blob's ink.
CRUMB_SHARE = 50

#: One straight line, ``(x1, y1, x2, y2)``.
CutLine = tuple[int, int, int, int]

#: The eight neighbours, in the order both languages visit them.
NEIGHBOURS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


@dataclass(frozen=True)
class PieceBox:
    """One piece's extent in the mask's frame, and how many pixels it holds."""

    x: int
    y: int
    w: int
    h: int
    area: int


@dataclass(frozen=True)
class BlobPieces:
    """A cut blob: each ink pixel's piece number (``-1`` off the ink), and the pieces'
    boxes in piece order."""

    labels: np.ndarray
    boxes: list[PieceBox]


def crumb_size(total: int) -> int:
    """The fewest pixels a piece of a ``total``-pixel blob may have."""
    return max(CRUMB_MIN_PIXELS, total // CRUMB_SHARE)


def is_under_line(column: int, row: int, line: CutLine) -> bool:
    """Whether the pixel's centre lies within the cut's radius of the segment.

    Exact integer arithmetic: past either end the distance is to that end, and
    alongside the segment its squared distance times the squared length is
    ``|p|² · L - (p · d)²``.
    """
    x1, y1, x2, y2 = line
    dx, dy = x2 - x1, y2 - y1
    px, py = column - x1, row - y1
    length = dx * dx + dy * dy
    along = px * dx + py * dy
    if length == 0 or along <= 0:
        return px * px + py * py <= CUT_RADIUS_SQUARED
    if along >= length:
        qx, qy = column - x2, row - y2
        return qx * qx + qy * qy <= CUT_RADIUS_SQUARED
    return (px * px + py * py) * length - along * along <= CUT_RADIUS_SQUARED * length


def cut_blob_into_pieces(mask: np.ndarray, lines: Sequence[CutLine]) -> BlobPieces:
    """The blob's pieces once the lines are cut through it: the steps in the module's
    docstring, in order."""
    height, width = mask.shape
    ink: list[list[bool]] = mask.astype(bool).tolist()
    total = sum(row.count(True) for row in ink)

    kept = [
        [ink[row][column] and not any(is_under_line(column, row, line) for line in lines) for column in range(width)]
        for row in range(height)
    ]
    smallest = crumb_size(total)
    numbered = [
        (index, pixels) for index, pixels in enumerate(find_components(kept, width, height)) if len(pixels) >= smallest
    ]
    pieces = [pixels for index, pixels in sorted(numbered, key=lambda entry: piece_order_key(entry[1], entry[0]))]

    labels = [[-1] * width for _ in range(height)]
    for number, pixels in enumerate(pieces):
        for row, column in pixels:
            labels[row][column] = number
    if pieces:
        give_back_pixels(ink, labels, width, height)
    array = np.asarray(labels, dtype=np.int32).reshape(height, width)
    return BlobPieces(labels=array, boxes=measure_pieces(array, len(pieces)))


def find_components(kept: list[list[bool]], width: int, height: int) -> list[list[tuple[int, int]]]:
    """The 8-connected components of the kept pixels, as ``(row, column)`` lists, in
    the raster order of their first pixel."""
    seen = [[False] * width for _ in range(height)]
    found: list[list[tuple[int, int]]] = []
    for row in range(height):
        for column in range(width):
            if not kept[row][column] or seen[row][column]:
                continue
            seen[row][column] = True
            pixels: list[tuple[int, int]] = []
            queue = deque([(row, column)])
            while queue:
                y, x = queue.popleft()
                pixels.append((y, x))
                for dy, dx in NEIGHBOURS:
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and kept[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        queue.append((ny, nx))
            found.append(pixels)
    return found


def piece_order_key(pixels: list[tuple[int, int]], raster_index: int) -> tuple[int, int, int, int]:
    """Rightmost right edge first, then larger ``left + right``, then higher top, then
    raster order."""
    left = min(x for _, x in pixels)
    right = max(x for _, x in pixels) + 1
    top = min(y for y, _ in pixels)
    return (-right, -(left + right), top, raster_index)


def give_back_pixels(ink: list[list[bool]], labels: list[list[int]], width: int, height: int) -> None:
    """Give every ink pixel without a piece to a neighbouring piece, one ring at a time.

    Each ring is decided on the labels as they stood before it, so the order pixels are
    visited in changes nothing. Ink no ring can reach goes to piece 0; that can't
    happen in a connected blob. In place.
    """
    pending = [
        (row, column)
        for row in range(height)
        for column in range(width)
        if ink[row][column] and labels[row][column] < 0
    ]
    while pending:
        taken: list[tuple[int, int, int]] = []
        for row, column in pending:
            best = -1
            for dy, dx in NEIGHBOURS:
                ny, nx = row + dy, column + dx
                if 0 <= ny < height and 0 <= nx < width:
                    number = labels[ny][nx]
                    if number >= 0 and (best < 0 or number < best):
                        best = number
            if best >= 0:
                taken.append((row, column, best))
        if not taken:
            break
        for row, column, number in taken:
            labels[row][column] = number
        pending = [(row, column) for row, column in pending if labels[row][column] < 0]
    for row, column in pending:
        labels[row][column] = 0


def measure_pieces(labels: np.ndarray, count: int) -> list[PieceBox]:
    """Each piece's box and pixel count, in piece order."""
    boxes = []
    for number in range(count):
        rows, columns = np.nonzero(labels == number)
        left, top = int(columns.min()), int(rows.min())
        boxes.append(
            PieceBox(
                x=left,
                y=top,
                w=int(columns.max()) - left + 1,
                h=int(rows.max()) - top + 1,
                area=int(rows.size),
            )
        )
    return boxes


__all__ = [
    "CRUMB_MIN_PIXELS",
    "CRUMB_SHARE",
    "CUT_RADIUS_SQUARED",
    "BlobPieces",
    "CutLine",
    "PieceBox",
    "crumb_size",
    "cut_blob_into_pieces",
    "is_under_line",
]

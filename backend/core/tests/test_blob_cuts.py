"""The knife: one blob cut into pieces along lines a person drew.

The fixture and every expected number are the same as in
``frontend/src/lib/calibration/blobCuts.check.ts``: the server and the editor must cut
the same pixels. No database, no image.
"""

from unittest import TestCase

import numpy as np

from core.imaging.blob_cuts import CutLine, crumb_size, cut_blob_into_pieces, is_under_line

#: An alef standing on the tip of a bowl, a lam rising on the right: one blob.
ART = [
    "....................",
    "..###.........####..",
    "..###.........####..",
    "..###.........####..",
    "..###.........####..",
    "..###.........####..",
    "..###.........####..",
    "..###.........####..",
    "..###.........####..",
    ".####.........####..",
    ".###..........####..",
    ".###..........####..",
    ".####.........####..",
    ".################...",
    "..##############....",
    "....................",
]
MASK = np.array([[ch == "#" for ch in row] for row in ART])


def boxes_of(lines: list[CutLine]) -> list[tuple[int, int, int, int, int]]:
    return [(b.x, b.y, b.w, b.h, b.area) for b in cut_blob_into_pieces(MASK, lines).boxes]


def row_of(lines: list[CutLine], row: int) -> str:
    labels = cut_blob_into_pieces(MASK, lines).labels[row]
    return "".join(str(v) if v >= 0 else "." for v in labels)


class BlobCutTests(TestCase):
    def test_a_flat_cut_under_the_alef_parts_it_from_the_bowl(self):
        # The bowl and lam first, since they reach furthest right; then the alef.
        self.assertEqual(boxes_of([(-1, 9, 6, 9)]), [(1, 1, 17, 14, 92), (2, 1, 3, 8, 24)])
        # The line's own pixels went back: nothing is lost (92 + 24 = 116).
        self.assertEqual(int(MASK.sum()), 116)
        self.assertEqual(row_of([(-1, 9, 6, 9)], 8), "..111.........0000..")
        self.assertEqual(row_of([(-1, 9, 6, 9)], 9), ".0000.........0000..")

    def test_a_line_that_does_not_cross_the_ink_leaves_one_piece(self):
        self.assertEqual(boxes_of([(2, 0, 2, 3)]), [(1, 1, 17, 14, 116)])

    def test_a_vertical_cut_puts_the_right_piece_first(self):
        self.assertEqual(boxes_of([(9, -1, 9, 16)]), [(9, 1, 9, 14, 63), (1, 1, 8, 14, 53)])

    def test_two_lines_make_three_pieces(self):
        self.assertEqual(
            boxes_of([(-1, 9, 6, 9), (9, -1, 9, 16)]),
            [(9, 1, 9, 14, 63), (1, 9, 8, 6, 29), (2, 1, 3, 8, 24)],
        )

    def test_any_slope_cuts(self):
        self.assertEqual(boxes_of([(0, 6, 7, 12)]), [(1, 1, 17, 14, 93), (2, 1, 3, 8, 23)])
        self.assertEqual(row_of([(0, 6, 7, 12)], 8), "..011.........0000..")

    def test_a_crumb_is_given_back_rather_than_counted(self):
        # A line across one corner chips off a single pixel: a crumb, not a piece. It
        # goes back, with the line's own pixels, to the one piece there is.
        square = np.ones((12, 12), dtype=bool)
        cut = cut_blob_into_pieces(square, [(-1, 3, 3, -1)])
        self.assertEqual([(b.x, b.y, b.w, b.h, b.area) for b in cut.boxes], [(0, 0, 12, 12, 144)])
        self.assertEqual(crumb_size(144), 8)
        self.assertEqual(crumb_size(1000), 20)

    def test_the_band_under_a_line_is_exact_integer_geometry(self):
        self.assertTrue(is_under_line(5, 6, (0, 5, 10, 5)))
        self.assertFalse(is_under_line(5, 7, (0, 5, 10, 5)))
        # Past an end, the distance is to that end.
        self.assertTrue(is_under_line(11, 5, (0, 5, 10, 5)))
        self.assertFalse(is_under_line(12, 5, (0, 5, 10, 5)))
        # On the diagonal, a pixel beside the line is within one pixel of it.
        self.assertTrue(is_under_line(4, 3, (0, 0, 10, 10)))
        self.assertFalse(is_under_line(5, 3, (0, 0, 10, 10)))

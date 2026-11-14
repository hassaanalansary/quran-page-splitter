"""The edge-ink rule: ink touching a line crop's top or bottom row is a neighbour's."""

import numpy as np
from django.test import SimpleTestCase
from PIL import Image, ImageDraw

from api.models import Line
from api.services.export import cut_edge_ink, line_crop_box
from core.imaging import find_edge_ink, find_ink, make_transparent


def ink_mask(rows: list[str]) -> np.ndarray:
    """A mask from a picture: '#' is ink, anything else paper."""
    return np.array([[cell == "#" for cell in row] for row in rows])


class FindEdgeInkTests(SimpleTestCase):
    def test_pieces_touching_the_top_or_bottom_row_are_found_and_the_rest_kept(self):
        ink = ink_mask(
            [
                "..#.....",
                "..#.....",
                "......#.",
                "#.....#.",
                "....#...",
                "....#...",
            ]
        )
        found = find_edge_ink(ink)
        np.testing.assert_array_equal(
            found,
            ink_mask(
                [
                    "..#.....",
                    "..#.....",
                    "........",
                    "........",
                    "....#...",
                    "....#...",
                ]
            ),
        )

    def test_a_piece_touching_only_the_left_or_right_edge_is_kept(self):
        ink = ink_mask(
            [
                "......",
                "#....#",
                "#....#",
                "......",
            ]
        )
        self.assertFalse(find_edge_ink(ink).any())

    def test_a_diagonal_step_joins_a_piece_to_the_one_touching_the_edge(self):
        ink = ink_mask(
            [
                "#....",
                ".#...",
                "..#..",
                ".....",
            ]
        )
        np.testing.assert_array_equal(find_edge_ink(ink), ink)

    def test_an_empty_crop_finds_nothing(self):
        self.assertEqual(find_edge_ink(np.zeros((0, 5), dtype=bool)).shape, (0, 5))

    def test_ink_is_whatever_is_not_near_white_like_make_transparent_cuts(self):
        crop = Image.new("RGB", (3, 1), (255, 255, 255))
        crop.putpixel((1, 0), (201, 201, 201))
        crop.putpixel((2, 0), (200, 255, 255))
        np.testing.assert_array_equal(find_ink(crop), [[False, False, True]])


class CutEdgeInkTests(SimpleTestCase):
    def test_the_neighbours_ink_goes_and_the_lines_own_stays(self):
        page = Image.new("RGB", (60, 100), (255, 255, 255))
        draw = ImageDraw.Draw(page)
        draw.rectangle((10, 20, 14, 33), fill=(0, 0, 0))  # a tail from the line above
        draw.rectangle((30, 40, 50, 50), fill=(0, 0, 0))  # the line's own letters
        draw.rectangle((40, 32, 42, 34), fill=(0, 0, 0))  # its own dot, well inside
        line = Line(bbox_x=0, bbox_y=30, bbox_w=60, bbox_h=30)

        rgba = make_transparent(page.crop(line_crop_box(page, line, None)))
        cut_edge_ink(rgba, page, line, None)
        alpha = np.asarray(rgba.getchannel("A"))

        self.assertFalse(alpha[0:4, 10:15].any())  # page rows 30 to 33: the tail, gone
        self.assertTrue(alpha[10:21, 30:51].all())  # the letters, kept
        self.assertTrue(alpha[2:5, 40:43].all())  # the dot, kept

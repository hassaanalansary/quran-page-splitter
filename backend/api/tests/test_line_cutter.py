"""Valley-based line splitting (pure core, no DB).

The splitter reads the line count off the page's own ink distribution, so every
window it uses has to be expressed relative to the line pitch. The smoothing
width was the one that was not: a pixel count tuned on a 300-dpi mushaf, which
on a page rendered four times smaller spans two thirds of a line and erases the
very troughs it is meant to sharpen.
"""

import numpy as np
from django.test import SimpleTestCase

from core.line_cutter import _smoothing_kernel_size, split_by_valleys

#: Pitches measured from real runs: Al-Shamarli's 300-dpi render, and a mushaf
#: whose pages come out at roughly a quarter of that.
SHAMARLI_PITCH = 486.0
SMALL_RENDER_PITCH = 111.0


class SmoothingKernelTests(SimpleTestCase):
    def test_reproduces_the_hand_tuned_width_on_a_300dpi_page(self):
        """The ratio is calibrated to the value that was tuned by eye — this is
        the check that the change is not a behaviour change where it mattered."""
        self.assertAlmostEqual(_smoothing_kernel_size(SHAMARLI_PITCH), 75, delta=2)

    def test_shrinks_on_a_low_resolution_render(self):
        """75px on a 111px pitch smoothed the inter-line gaps away."""
        size = _smoothing_kernel_size(SMALL_RENDER_PITCH)
        self.assertLess(size, SMALL_RENDER_PITCH / 3)
        self.assertGreater(size, 3)

    def test_is_always_odd_so_the_average_stays_centred(self):
        """An even window shifts the profile half a row and drags valleys with it."""
        for pitch in (20, 40, 111, 300, 486, 900):
            self.assertEqual(_smoothing_kernel_size(pitch) % 2, 1)

    def test_never_degenerates_on_a_tiny_page(self):
        self.assertGreaterEqual(_smoothing_kernel_size(1), 3)


def _page(pitch: int, lines: int, ink_rows: int) -> tuple[np.ndarray, np.ndarray]:
    """A synthetic page: evenly spaced ink bands on a blank ground."""
    height = pitch * lines
    binary = np.zeros((height, 400), dtype=np.uint8)
    for index in range(lines):
        top = index * pitch + (pitch - ink_rows) // 2
        binary[top : top + ink_rows, 50:350] = 255
    return np.full_like(binary, 255), binary


class SplitByValleysTests(SimpleTestCase):
    def _boundaries_are_between_lines(self, pitch: int, lines: int, ink_rows: int) -> None:
        grey, binary = _page(pitch, lines, ink_rows)
        boxes = split_by_valleys(grey, binary, lines, padding=0)

        self.assertEqual(len(boxes), lines)
        for index, box in enumerate(boxes):
            ink_top = index * pitch + (pitch - ink_rows) // 2
            ink_bottom = ink_top + ink_rows
            # Each box must contain its own line's ink and nothing else's.
            self.assertLessEqual(box["top"], ink_top, f"line {index} clipped at the top")
            self.assertGreaterEqual(box["bottom"], ink_bottom, f"line {index} clipped at the bottom")
            if index > 0:
                previous_bottom = (index - 1) * pitch + (pitch - ink_rows) // 2 + ink_rows
                self.assertGreaterEqual(box["top"], previous_bottom, f"line {index} eats the line above")

    def test_splits_a_300dpi_style_page(self):
        self._boundaries_are_between_lines(pitch=480, lines=6, ink_rows=300)

    def test_splits_a_low_resolution_page(self):
        """The case the fixed 75px kernel could not handle."""
        self._boundaries_are_between_lines(pitch=111, lines=8, ink_rows=70)

    def test_isolates_a_low_ink_line_between_dense_neighbours(self):
        """A besmella: one short, faint line surrounded by full ones.

        Under an oversized kernel the heavier neighbours fill in its troughs and
        the boundary lands inside the besmella's own rows.
        """
        pitch, lines, ink_rows = 111, 5, 70
        grey, binary = _page(pitch, lines, ink_rows)
        besmella = 2
        top = besmella * pitch + (pitch - ink_rows) // 2
        binary[top : top + ink_rows, :] = 0
        # Short, centred, and only a few rows tall.
        binary[top + 25 : top + 45, 150:250] = 255

        boxes = split_by_valleys(grey, binary, lines, padding=0)

        self.assertEqual(len(boxes), lines)
        box = boxes[besmella]
        self.assertLessEqual(box["top"], top + 25)
        self.assertGreaterEqual(box["bottom"], top + 45)
        # And it must not have swallowed either neighbour's ink.
        above_bottom = (besmella - 1) * pitch + (pitch - ink_rows) // 2 + ink_rows
        below_top = (besmella + 1) * pitch + (pitch - ink_rows) // 2
        self.assertGreaterEqual(box["top"], above_bottom)
        self.assertLessEqual(box["bottom"], below_top)

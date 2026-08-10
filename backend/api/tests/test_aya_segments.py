"""Segment geometry for detected aya separators (pure core, no DB).

Exercises ``_create_segments`` directly rather than through ``split_segments``:
the arithmetic under test is the translation between the matcher's line-box
coordinates and the content window, and driving it through a real page would
bury that behind template matching without testing it any harder.

Matching runs across the whole line while segments are cut from the content —
deliberately, because a separator at the very end of a line cannot be matched
inside a region trimmed to the ink. The two spaces used to be mixed, which
pushed segment right edges past the content and dropped the rightmost segment
of a short line.
"""

from itertools import pairwise

import numpy as np
from django.test import SimpleTestCase
from PIL import Image

from core.aya_separator import AyaSeparatorProcessor
from core.context import BBox, LineResult

LINE_LEFT = 100
LINE_WIDTH = 1000
#: Content sits well inside the line box — the case that used to go wrong.
CONTENT_X, CONTENT_W = 300, 400
CONTENT_RIGHT = CONTENT_X + CONTENT_W


def _processor() -> AyaSeparatorProcessor:
    template = Image.fromarray(np.full((20, 20), 128, dtype=np.uint8))
    return AyaSeparatorProcessor(template=template)


def _line() -> LineResult:
    return LineResult(
        bbox=BBox(left=LINE_LEFT, top=50, right=LINE_LEFT + LINE_WIDTH, bottom=150),
        line_index=1,
    )


def _spans(line: LineResult) -> list[tuple[int, int, bool]]:
    """Segments as (left, right, has_separator), relative to the line box."""
    return [
        (seg.bbox.left - LINE_LEFT, seg.bbox.right - LINE_LEFT, seg.has_separator) for seg in line.segments
    ]


class ShortLineTests(SimpleTestCase):
    def test_segments_tile_the_content_without_overshooting(self):
        line = _line()
        _processor()._create_segments(line, [(350, 370), (550, 570)], CONTENT_X, CONTENT_W)

        self.assertEqual(
            _spans(line),
            [(550, 700, True), (350, 550, True), (300, 350, False)],
        )

    def test_no_segment_reaches_past_the_content(self):
        """The reported bug: boxes drawn wider than the text they contain."""
        line = _line()
        _processor()._create_segments(line, [(350, 370), (550, 570)], CONTENT_X, CONTENT_W)

        widest = max(seg.bbox.right for seg in line.segments)
        self.assertEqual(widest, LINE_LEFT + CONTENT_RIGHT)

    def test_rightmost_segment_survives(self):
        """It used to compute a negative width and vanish, losing the first aya."""
        line = _line()
        _processor()._create_segments(line, [(550, 570)], CONTENT_X, CONTENT_W)

        self.assertEqual(_spans(line), [(550, 700, True), (300, 550, False)])

    def test_segments_do_not_overlap(self):
        line = _line()
        _processor()._create_segments(line, [(350, 370), (450, 470), (600, 620)], CONTENT_X, CONTENT_W)

        ordered = sorted((seg.bbox.left, seg.bbox.right) for seg in line.segments)
        for (_, earlier_right), (later_left, _) in pairwise(ordered):
            self.assertLessEqual(earlier_right, later_left)


class MarginHitTests(SimpleTestCase):
    def test_a_hit_outside_the_content_is_discarded(self):
        """Matching sweeps the blank margins too, so a stray hit must collapse."""
        line = _line()
        _processor()._create_segments(line, [(500, 520), (900, 920)], CONTENT_X, CONTENT_W)

        self.assertEqual(_spans(line), [(500, 700, True), (300, 500, False)])

    def test_a_separator_ending_the_line_is_clamped_not_dropped(self):
        """The reason matching sweeps the whole line in the first place.

        The last separator on a line sits at the left edge of the ink, and the
        template carries white padding, so its match lands *left* of the content
        box. Clamping cuts it at the ink edge and keeps it as a separator —
        discarding it would silently merge two ayat.
        """
        line = _line()
        _processor()._create_segments(line, [(280, 300), (500, 520)], CONTENT_X, CONTENT_W)

        self.assertEqual(_spans(line), [(500, 700, True), (300, 500, True)])


class FullWidthLineTests(SimpleTestCase):
    """A line whose ink spans the whole box takes the untrimmed path — its
    output must be exactly what it was before the coordinate fix."""

    def test_unchanged(self):
        line = _line()
        _processor()._create_segments(line, [(300, 320), (600, 620)], 0, LINE_WIDTH)

        self.assertEqual(
            _spans(line),
            [(600, 1000, True), (300, 600, True), (0, 300, False)],
        )

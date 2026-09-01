"""Tests for core.word_boundary — the boundary, not the algorithm.

The alignment itself is judged by eye, on real pages, against a byte-identical
render of sura 7. What is pinned here is the *contract*: that the engine returns
data and nothing else, that its coordinates are the caller's coordinates, and that
supplied knowledge short-circuits the detection it replaces.

Lines are drawn rather than loaded. Plain filled rectangles all sitting on one
writing line make every blob a letter body of a known width at a known x, so what
the DP should do with them is arithmetic — which is the point: a fixture whose
expected answer needs the engine to compute it would pin nothing.

Lives under ``quran`` rather than ``core`` because there is no test package there.
Nothing here touches the database.
"""

from dataclasses import fields, is_dataclass
from typing import ClassVar

from django.test import SimpleTestCase
from PIL import Image, ImageDraw

from core.word_boundary import (
    LineImage,
    WordBoundaryInput,
    WordInput,
    detect_words,
)

#: Ink rows. Every blob spans these, so every blob crosses the writing line and
#: reads as a body — no marks, nothing for the parser to be undecided about.
TOP, BOTTOM = 20, 40


def _line(
    xs: list[int],
    *,
    width: int = 30,
    size: tuple[int, int] = (400, 60),
    label: str = "line-01.png",
    separators: list[tuple[int, int]] | None = None,
) -> LineImage:
    """One line whose ink is a rectangle at each x, ``width`` wide."""
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for x in xs:
        draw.rectangle([x, TOP, x + width - 1, BOTTOM], fill=(0, 0, 0, 255))
    return LineImage(image=image, label=label, source=f"test:{label}", separators=separators)


def _words(paws: list[int], aya: str = "7:82") -> list[WordInput]:
    return [
        WordInput(text=f"w{i}", paws=count, ijam_above=0, ijam_below=0, aya=aya, id=100 + i)
        for i, count in enumerate(paws)
    ]


def _assert_pure(case: SimpleTestCase, value: object, path: str) -> None:
    """Every reachable value is a dataclass, a str, a number, a bool or a list."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return
    if isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            _assert_pure(case, item, f"{path}[{i}]")
        return
    if is_dataclass(value) and not isinstance(value, type):
        for field in fields(value):
            _assert_pure(case, getattr(value, field.name), f"{path}.{field.name}")
        return
    case.fail(f"{path} is a {type(value).__module__}.{type(value).__name__}, which is not pure data")


class ResultIsPureDataTests(SimpleTestCase):
    def setUp(self):
        self.result = detect_words(
            WordBoundaryInput(lines=[_line([50, 100, 150, 200])], words=_words([1, 2, 1]))
        )

    def test_nothing_but_data_comes_back(self):
        """No PIL image, no numpy array, no LineInk — the next phase writes rows."""
        _assert_pure(self, self.result, "result")

    def test_the_span_was_accounted_for(self):
        self.assertTrue(self.result.complete)
        self.assertEqual(self.result.words_consumed, 3)

    def test_words_point_at_components_that_exist(self):
        line = self.result.lines[0]
        known = {component.id for component in line.components}
        for word in line.words:
            self.assertTrue(set(word.components) <= known, f"{word.text} cites a component that is not there")

    def test_the_word_stream_is_carried_through(self):
        line = self.result.lines[0]
        self.assertEqual([w.index for w in line.words], [0, 1, 2])
        self.assertEqual([w.word_id for w in line.words], [100, 101, 102])
        self.assertEqual([w.expected_paws for w in line.words], [1, 2, 1])
        self.assertEqual([w.aya for w in line.words], ["7:82"] * 3)

    def test_the_line_is_labelled_as_the_caller_labelled_it(self):
        self.assertEqual(self.result.lines[0].label, "line-01.png")
        self.assertEqual(self.result.lines[0].source, "test:line-01.png")


class ImageCoordinateTests(SimpleTestCase):
    """The engine works in a tight crop and must hand back the caller's space."""

    def _line_result(self, xs: list[int]):
        result = detect_words(WordBoundaryInput(lines=[_line(xs)], words=_words([1, 2, 1])))
        return result.lines[0]

    def test_the_crop_offset_is_measured_not_assumed(self):
        line = self._line_result([50, 100, 150, 200])
        # The ink starts 50px in and 20 rows down; nothing supplied that, and
        # nothing may force it to zero.
        self.assertEqual(line.crop_offset, (50, TOP))

    def test_components_land_on_the_ink_not_on_the_crop(self):
        line = self._line_result([50, 100, 150, 200])
        self.assertEqual(sorted(c.x for c in line.components), [50, 100, 150, 200])
        self.assertTrue(all(c.y == TOP for c in line.components))

    def test_the_band_is_in_image_coordinates(self):
        line = self._line_result([50, 100, 150, 200])
        self.assertGreaterEqual(line.band[0], TOP)
        self.assertLessEqual(line.band[1], BOTTOM)

    def test_word_ends_are_the_words_own_left_edges(self):
        """Arabic runs right to left: word 0 is the rightmost blob."""
        line = self._line_result([50, 100, 150, 200])
        self.assertEqual([w.end_x for w in line.words], [200, 100, 50])
        self.assertEqual([w.x for w in line.words], [200, 100, 50])
        self.assertEqual([w.right for w in line.words], [230, 180, 80])

    def test_a_wider_margin_moves_everything_with_it(self):
        """The same ink 100px further in gives the same reading, 100px further in.

        This is what a hardcoded zero offset would break, and it would break it
        silently — every box still plausible, every one of them in the wrong place.
        """
        near = self._line_result([50, 100, 150, 200])
        far = self._line_result([150, 200, 250, 300])
        self.assertEqual(far.crop_offset, (150, TOP))
        self.assertEqual(
            [w.end_x + 100 for w in near.words],
            [w.end_x for w in far.words],
        )


class SuppliedSeparatorTests(SimpleTestCase):
    """Ornaments the caller already knows about must not be looked for again.

    Proved with a plain rectangle. The shape detector needs a ring with a hole, so
    it can never flag one of these — an ornament here exists only because it was
    handed over.
    """

    XS: ClassVar[list[int]] = [50, 100, 150, 200]
    #: The rightmost rectangle, in image coordinates.
    SPAN = (200, 235)

    def _run(self, separators):
        return detect_words(
            WordBoundaryInput(
                lines=[_line(self.XS, separators=separators)],
                # Three blobs of text; the fourth is the ornament.
                words=_words([1, 2]),
            )
        ).lines[0]

    def test_a_supplied_span_becomes_an_ornament(self):
        line = self._run([self.SPAN])
        self.assertEqual(len(line.ornaments), 1)
        self.assertEqual((line.ornaments[0].left, line.ornaments[0].right), (200, 230))

    def test_the_ornament_stops_being_text(self):
        line = self._run([self.SPAN])
        roles = sorted(component.role for component in line.components)
        self.assertEqual(roles, ["body", "body", "body", "ornament"])
        self.assertEqual([w.text for w in line.words], ["w0", "w1"])

    def test_the_ornament_cites_the_component_it_is_made_of(self):
        line = self._run([self.SPAN])
        ids = {c.id for c in line.components if c.role == "ornament"}
        self.assertEqual(set(line.ornaments[0].components), ids)

    def test_none_means_find_them_yourself_and_these_are_not_ornaments(self):
        """The other half of the switch: without a hint, the detectors run.

        They run and find nothing, which is right — a rectangle is not a ring.
        """
        line = detect_words(
            WordBoundaryInput(lines=[_line(self.XS, separators=None)], words=_words([1, 2, 1]))
        ).lines[0]
        self.assertEqual(line.ornaments, [])
        self.assertNotIn("ornament", {component.role for component in line.components})


class MultipleLineTests(SimpleTestCase):
    """One cursor walks the span: where a line stops is where the next begins."""

    def test_the_word_stream_carries_across_lines(self):
        result = detect_words(
            WordBoundaryInput(
                lines=[
                    _line([50, 100, 150], label="line-01.png"),
                    _line([50, 100], label="line-02.png"),
                ],
                words=_words([1, 2, 1, 1]),
            )
        )
        self.assertEqual([len(line.words) for line in result.lines], [2, 2])
        self.assertEqual([w.index for line in result.lines for w in line.words], [0, 1, 2, 3])
        self.assertTrue(result.complete)

    def test_an_unconsumed_span_is_not_reported_as_a_reading(self):
        """Too many words for the ink: the last line's cuts are withdrawn."""
        result = detect_words(
            WordBoundaryInput(lines=[_line([50, 100])], words=_words([1, 1, 1, 1, 1, 1]))
        )
        self.assertFalse(result.complete)
        self.assertEqual(result.lines[0].status, "unresolved")
        self.assertEqual(result.lines[0].words, [])

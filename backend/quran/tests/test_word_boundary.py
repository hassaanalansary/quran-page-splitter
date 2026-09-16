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
from core.word_boundary.alignment import ParseRecord, _merge_record

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
        self.result = detect_words(WordBoundaryInput(lines=[_line([50, 100, 150, 200])], words=_words([1, 2, 1])))

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
        line = detect_words(WordBoundaryInput(lines=[_line(self.XS, separators=None)], words=_words([1, 2, 1]))).lines[
            0
        ]
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
        result = detect_words(WordBoundaryInput(lines=[_line([50, 100])], words=_words([1, 1, 1, 1, 1, 1])))
        self.assertFalse(result.complete)
        self.assertEqual(result.lines[0].status, "unresolved")
        self.assertEqual(result.lines[0].words, [])

    def test_ink_the_stream_never_reached_is_not_reported_as_exact(self):
        """Too few words for the ink: the mirror case, and the one that hid.

        A run over al-Baqara drifted a whole aya ahead, spent every word of its span
        by page 10 line 11, and handed the next nineteen lines of real ink back as
        ``exact`` with nothing on them — green dots, nothing to review. A line the
        stream never reached is a finding, not a clean parse of nothing. A line with
        no ink at all is still nothing, and stays so.
        """
        result = detect_words(
            WordBoundaryInput(
                lines=[
                    _line([50, 100], label="line-01.png"),
                    _line([50, 100], label="line-02.png"),
                    _line([], label="line-03.png"),
                ],
                words=_words([1, 1]),
            )
        )
        self.assertTrue(result.complete)
        self.assertEqual(result.lines[0].status, "exact")
        self.assertEqual(len(result.lines[0].words), 2)
        self.assertEqual(result.lines[1].status, "unresolved")
        self.assertEqual(result.lines[1].reason, "words-exhausted")
        self.assertEqual(result.lines[1].words, [])
        self.assertEqual(result.lines[2].status, "exact")
        self.assertEqual(result.lines[2].words, [])


class MergeTieBreakTests(SimpleTestCase):
    """What survives when two readings reach the same DP state.

    Reaching into ``alignment`` for a private on purpose: this is an invariant of
    the algorithm rather than of the package's surface, and the only honest way to
    pin it is to drive the merge directly. Going through ``detect_words`` would
    need a fixture contrived enough that a failure would say nothing about which
    rule broke.
    """

    KEY = (3, 0)

    def _record(self, cost: int, deviations: int, body_mask: int) -> ParseRecord:
        return ParseRecord(
            cost=cost,
            ends=(),
            groups=(),
            current_group=(),
            body_mask=body_mask,
            deviations=deviations,
        )

    def test_equal_cost_prefers_the_reading_that_bends_the_spelling_less(self):
        """The tier ``rank`` gained, enforced where it actually bites.

        Cost already charges COUNT_WEIGHT per deviation, so an equal total means a
        word read off-count paid for by cheaper components. Of the two, the reading
        that keeps every word on its PAW count is the better answer — and before
        this it lost or won by which one the DP happened to reach the key with.
        """
        target: dict[tuple[int, int], ParseRecord] = {}
        _merge_record(target, self.KEY, self._record(10, 1, 0b01))
        _merge_record(target, self.KEY, self._record(10, 0, 0b10))
        self.assertEqual(target[self.KEY].deviations, 0)

    def test_the_order_they_arrive_in_does_not_decide_it(self):
        """The same assertion with the arrivals swapped. Without this the test
        above would pass just as well on a rule of "last one wins"."""
        target: dict[tuple[int, int], ParseRecord] = {}
        _merge_record(target, self.KEY, self._record(10, 0, 0b10))
        _merge_record(target, self.KEY, self._record(10, 1, 0b01))
        self.assertEqual(target[self.KEY].deviations, 0)

    def test_a_genuine_tie_is_still_kept_as_ambiguity(self):
        """Equal on *both* tiers is a real tie, and must stay reported.

        ``role_ambiguous_mask`` is what the i'jam diagnostic reads to tell "no
        valid reading existed" apart from "a valid reading may have been discarded
        here" — see ``_parse_segment``. If this stopped being set, that split would
        silently start answering the first for every line.
        """
        target: dict[tuple[int, int], ParseRecord] = {}
        _merge_record(target, self.KEY, self._record(10, 1, 0b01))
        _merge_record(target, self.KEY, self._record(10, 1, 0b10))
        self.assertEqual(target[self.KEY].deviations, 1)
        self.assertTrue(target[self.KEY].role_ambiguous_mask)

    def test_a_dearer_reading_never_displaces_a_cheaper_one(self):
        target: dict[tuple[int, int], ParseRecord] = {}
        _merge_record(target, self.KEY, self._record(10, 5, 0b01))
        _merge_record(target, self.KEY, self._record(12, 0, 0b10))
        self.assertEqual(target[self.KEY].cost, 10)


#: Bodies right to left: two for the dotted word, then one each for four fillers.
#: The dot sits between the first two, so it falls inside the dotted word's span
#: and can satisfy its i'jam — or be eaten by it.
_IJAM_BODIES = (520, 460, 380, 300, 220, 140)
_IJAM_DOT_X = 505
#: An ornament past the left end. It closes the stretch, which pins `require_end`
#: on the last word — see `_ijam_line` for why the test needs that.
_IJAM_ORNAMENT = (80, 120)


def _ijam_line(label: str = "line-01.png") -> LineImage:
    """A line whose cheapest reading spends a dot as a letter.

    Six bodies and a dot for seven PAWs of text, so the *only* reading that gets
    every word to its exact count is the one that reads the dot as a letter. Every
    reading that keeps the dot has to close a word a PAW short, and that costs
    COUNT_WEIGHT — twenty against the thirteen the dot costs as a body. So the
    floor is the one thing that can refuse it, which is the case under test.

    **The ornament is load-bearing.** Without it the cheapest reading of all is to
    stop one word early: unplaced words are free when no ink is left over, so a
    reading that quietly drops the last word beats both of the ones we care about.
    An ornament closes the stretch, which pins ``require_end`` on the final word
    and removes every early stop from the running.
    """
    image = Image.new("RGBA", (700, 60), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for x in _IJAM_BODIES:
        draw.rectangle([x, TOP, x + 39, BOTTOM], fill=(0, 0, 0, 255))
    draw.rectangle([_IJAM_DOT_X, BOTTOM + 6, _IJAM_DOT_X + 7, BOTTOM + 13], fill=(0, 0, 0, 255))
    return LineImage(image=image, label=label, source=f"test:{label}", separators=[_IJAM_ORNAMENT])


def _ijam_words() -> list[WordInput]:
    """A three-PAW word carrying one dot below, then four plain one-PAW words."""
    return [
        WordInput(text="ببب", paws=3, ijam_above=0, ijam_below=1, aya="7:82", id=100),
        *[WordInput(text=f"w{i}", paws=1, ijam_above=0, ijam_below=0, aya="7:82", id=101 + i) for i in range(4)],
    ]


class IjamModeTests(SimpleTestCase):
    """Whether a word's expected dots are worth checking against this page at all.

    ``core.text.arabic.IJAM`` describes one dotting convention, not a universal
    fact: Maghribi puts ف's dot below where that table puts it above, and a mushaf
    may leave final ي undotted. On such a mushaf every word containing them reads
    as short, so the check is not merely useless but misleading — hence a mode
    that turns it off, declared per mushaf rather than guessed.
    """

    def _dotted(self, ijam: str):
        line = detect_words(WordBoundaryInput(lines=[_ijam_line()], words=_ijam_words(), ijam=ijam)).lines[0]
        return line, line.words[0]

    def test_report_flags_the_word_that_lost_its_dot(self):
        line, dotted = self._dotted("report")
        # Three blobs: the dot was spent as a letter, which is the cheapest reading
        # of this ink and the thing the flag is there to tell a reviewer about.
        self.assertEqual(len(dotted.components), 3)
        self.assertIn("i'jam", line.reason or "")

    def test_ignore_says_nothing_about_it(self):
        line, dotted = self._dotted("ignore")
        self.assertEqual(len(dotted.components), 3)
        self.assertNotIn("i'jam", line.reason or "")

    def test_the_mode_never_changes_the_reading(self):
        """Reporting is not a soft constraint — it costs the parse nothing.

        Worth pinning separately: if the check ever started influencing the
        outcome, a Maghribi mushaf would silently get different word boundaries
        from a Hafs one purely because of a table that does not describe it.
        """
        reported, _ = self._dotted("report")
        ignored, _ = self._dotted("ignore")
        self.assertEqual(
            [(w.text, w.x, w.end_x) for w in reported.words],
            [(w.text, w.x, w.end_x) for w in ignored.words],
        )

    def test_report_is_the_default(self):
        """A caller that says nothing gets the check, which is what it always did."""
        self.assertEqual(WordBoundaryInput(lines=[], words=[]).ijam, "report")

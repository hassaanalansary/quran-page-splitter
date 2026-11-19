"""Roles priced by the fingerprint library, and missing PAWs placed by likely touching
joins. No database."""

from dataclasses import replace
from unittest import TestCase

from PIL import Image, ImageDraw

from core.word_boundary.alignment import _off_count
from core.word_boundary.calibration import COUNT_WEIGHT, SURE_CONFIDENCE, SURE_PRICE
from core.word_boundary.engine import detect_prepared
from core.word_boundary.ink import Blob, analyse_line
from core.word_boundary.inputs import LineImage, WordBoundaryInput, WordInput
from core.word_boundary.separators import split_separators


def line(bodies, marks=(), label="line-01.png"):
    """Letters as 30x20 blocks on the writing line; marks as 8x6 blocks above it."""
    image = Image.new("RGBA", (400, 60), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for x in bodies:
        draw.rectangle([x, 20, x + 29, 40], fill=(0, 0, 0, 255))
    for x in marks:
        draw.rectangle([x, 4, x + 7, 9], fill=(0, 0, 0, 255))
    return LineImage(image, label, f"test:{label}", [], None)


def words(paws, weights=None):
    weights = weights or [COUNT_WEIGHT] * len(paws)
    return [WordInput(f"w{i}", count, 0, 0, "7:82", 100 + i, short_weight=weights[i]) for i, count in enumerate(paws)]


def read(lines, stream, priced=None):
    """The engine's reading, with ``priced`` (label → (role, confidence)) set from a
    library first."""
    source = WordBoundaryInput(lines, stream, ijam="ignore")
    inks = [analyse_line(item) for item in lines]
    for ink in inks:
        split_separators(ink, None)
        for blob in ink.components:
            if priced and blob.label in priced:
                blob.library_role, blob.library_confidence = priced[blob.label]
    return detect_prepared(source, inks), inks


class PriceTests(TestCase):
    def test_without_the_library_the_body_score_prices_as_before(self):
        blob = Blob(1, 0, 0, 10, 10, 100, body_score=11)
        self.assertEqual((blob.cost_as_body, blob.cost_as_mark), (3, 6))

    def test_the_librarys_role_is_free_and_the_other_costs_its_confidence(self):
        blob = Blob(1, 0, 0, 10, 10, 100, body_score=14, library_role="mark", library_confidence=1.0)
        self.assertEqual((blob.cost_as_mark, blob.cost_as_body), (0, SURE_PRICE))
        # Sure from SURE_CONFIDENCE up; below it, in proportion.
        self.assertEqual(replace(blob, library_confidence=SURE_CONFIDENCE).cost_as_body, SURE_PRICE)
        self.assertEqual(replace(blob, library_confidence=SURE_CONFIDENCE / 4).cost_as_body, SURE_PRICE // 4)

    def test_a_missing_paw_costs_the_words_own_weight(self):
        self.assertEqual(_off_count(2, 2, 17), 0)
        self.assertEqual(_off_count(1, 2, COUNT_WEIGHT), COUNT_WEIGHT)
        self.assertEqual(_off_count(1, 2, 17), 17)
        self.assertEqual(_off_count(1, 3, 17), 34)
        self.assertEqual(_off_count(3, 2, 8), COUNT_WEIGHT)  # a PAW too many is never explained


class TouchingPairTests(TestCase):
    """One word of three PAWs whose ink shows two letters and a mark — two of its
    letters printed touching."""

    def setUp(self):
        self.lines = [line([50, 150], marks=[110])]
        self.stream = words([3])

    def mark_label(self, inks):
        return min(inks[0].components, key=lambda blob: blob.area).label

    def test_the_body_score_promotes_the_mark_to_make_up_the_count(self):
        result, inks = read(self.lines, self.stream)
        mark = self.mark_label(inks)
        self.assertEqual(next(c.role for c in result.lines[0].components if c.id == mark), "body")
        self.assertEqual(result.lines[0].deviations, 0)

    def test_a_sure_library_keeps_the_mark_and_leaves_the_word_short(self):
        _, inks = read(self.lines, self.stream)
        result, _ = read(self.lines, self.stream, priced={self.mark_label(inks): ("mark", 0.9)})
        mark = self.mark_label(inks)
        self.assertEqual(next(c.role for c in result.lines[0].components if c.id == mark), "mark")
        self.assertEqual(result.lines[0].deviations, 1)

    def test_an_unsure_library_still_bends(self):
        _, inks = read(self.lines, self.stream)
        result, _ = read(self.lines, self.stream, priced={self.mark_label(inks): ("mark", 0.02)})
        mark = self.mark_label(inks)
        self.assertEqual(next(c.role for c in result.lines[0].components if c.id == mark), "body")


class ShortagePlacementTests(TestCase):
    """Two words of two PAWs each over three letters: one of them came up short, and
    the cheaper missing PAW — a join likely to touch — says which."""

    def bodies_per_word(self, weights):
        result, _ = read([line([50, 150, 250])], words([2, 2], weights))
        return [len(box.components) for box in result.lines[0].words]

    def test_the_shortage_goes_where_a_join_is_likely_to_touch(self):
        self.assertEqual(self.bodies_per_word([17, COUNT_WEIGHT]), [1, 2])
        self.assertEqual(self.bodies_per_word([COUNT_WEIGHT, 17]), [2, 1])

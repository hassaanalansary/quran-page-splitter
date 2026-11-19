"""A word's ink marks against its text's: types named, strokes joined, what does not fit."""

from typing import ClassVar
from unittest import TestCase

from core.text import text_marks
from core.word_boundary.mark_check import FoundMark, check_word, compound, parts_of


def found(ident: int, x: float, lane: str, **scores: float) -> FoundMark:
    return FoundMark(ident, x, lane, scores=scores)  # type: ignore[arg-type]


class CheckWordTests(TestCase):
    #: عَظِيمٌ — ع ظ ي م, right to left.
    letters: ClassVar[list[float]] = [90.0, 70.0, 50.0, 30.0]

    def test_every_mark_takes_its_texts_type_and_the_word_fits(self):
        marks = [
            found(1, 88, "above", fatha=0.05, damma=0.3),
            found(2, 70, "above", ijamDot=0.02, fatha=0.4),
            found(3, 72, "below", kasra=0.06, fatha=0.1),
            found(4, 50, "below", ijamDot=0.03),
            found(5, 34, "above", damma=0.07, fatha=0.3),
            found(6, 26, "above", damma=0.09, other=0.12),
        ]
        check = check_word(text_marks("عَظِيمٌ"), self.letters, 80, marks)
        self.assertEqual(check.types, {1: "fatha", 2: "ijamDot", 3: "kasra", 4: "ijamDot", 5: "damma", 6: "damma"})
        # The two strokes over the meem are its tanween — each typed as the vowel it looks like.
        self.assertEqual(check.tanween, {5, 6})
        self.assertTrue(check.clean)
        self.assertEqual(check.sure, {1, 2, 3, 4, 5, 6})

    def test_a_joined_tanween_is_one_blob(self):
        marks = [
            found(1, 88, "above", fatha=0.05),
            found(2, 70, "above", ijamDot=0.02),
            found(3, 72, "below", kasra=0.06),
            found(4, 50, "below", ijamDot=0.03),
            found(5, 30, "above", tanween=0.04, damma=0.2),
        ]
        check = check_word(text_marks("عَظِيمٌ"), self.letters, 80, marks)
        self.assertEqual(check.types[5], "tanween")
        self.assertEqual(check.tanween, set())
        self.assertTrue(check.clean)

    def test_what_does_not_fit_is_named(self):
        # أَمْ with its sukun gone and a stray mark under the meem.
        marks = [found(1, 60, "above", fatha=0.05), found(9, 10, "below", kasra=0.05)]
        check = check_word(text_marks("أَمْ"), [60, 30], 60, marks)
        self.assertEqual([mark.kind for mark in check.missing], ["sukun"])
        self.assertEqual(check.extra, [9])
        self.assertEqual(check.sure, set())

    def test_the_hamza_drawn_inside_its_alef_is_not_missing(self):
        check = check_word(
            text_marks("أَمْ"), [60, 30], 60, [found(1, 60, "above", fatha=0.05), found(2, 30, "above", sukun=0.04)]
        )
        self.assertTrue(check.clean)

    def test_a_typed_mark_the_text_names_otherwise_is_a_disagreement(self):
        marks = [
            found(1, 95, "above", fatha=0.05),
            found(2, 75, "above", ijamDot=0.05),
            found(3, 72, "above", fatha=0.05),
            found(4, 55, "above", damma=0.05),
            FoundMark(5, 15, "above", typed="sukun", scores={"sukun": 0.05}),
        ]
        check = check_word(text_marks("كَفَرُوا۟"), [95, 75, 55, 35, 15], 90, marks)
        self.assertEqual((check.types[5], check.disagree), ("roundZero", [5]))

    def test_a_blob_typed_as_two_marks_fills_both(self):
        # إِلَّا: the hamza and its kasra under the alef, printed as one blob.
        marks = [
            FoundMark(1, 60, "below", typed="hamza+kasra"),
            found(2, 35, "above", fatha=0.05),
            found(3, 30, "above", shadda=0.05),
        ]
        check = check_word(text_marks("إِلَّا"), [60, 35, 10], 60, marks)
        self.assertEqual(check.types[1], "hamza+kasra")
        self.assertTrue(check.clean)

    def test_one_blob_for_the_hamza_and_its_kasra_is_short_of_one(self):
        marks = [
            found(1, 60, "below", kasra=0.05),
            found(2, 35, "above", fatha=0.05),
            found(3, 30, "above", shadda=0.05),
        ]
        check = check_word(text_marks("إِلَّا"), [60, 35, 10], 60, marks)
        self.assertEqual(len(check.missing), 1)
        self.assertEqual(check.sure, set())

    def test_a_known_pair_is_taken_for_both(self):
        # The examples have seen the hamza and its kasra printed as one.
        marks = [
            found(1, 60, "below", kasra=0.10, **{"hamza+kasra": 0.04}),
            found(2, 35, "above", fatha=0.05),
            found(3, 30, "above", shadda=0.05),
        ]
        check = check_word(text_marks("إِلَّا"), [60, 35, 10], 60, marks)
        self.assertEqual(check.types[1], "hamza+kasra")
        self.assertTrue(check.clean)

    def test_a_pause_sign_the_text_lacks_is_no_error(self):
        marks = [
            found(1, 95, "above", fatha=0.05),
            found(2, 60, "below", ijamDot=0.03),
            found(3, 58, "above", sukun=0.04),
            found(4, 30, "below", ijamDot=0.03),
            found(5, 28, "above", fatha=0.05),
            found(6, 10, "above", waqfJim=0.05),
        ]
        check = check_word(text_marks("رَيْبَ"), [95, 60, 30], 90, marks)
        self.assertTrue(check.clean, check)
        self.assertNotIn(6, check.types)

    def test_three_dots_the_text_calls_the_embraced_pause_are_it(self):
        dots = [
            FoundMark(ident, x, "above", scores={"ijamDot": 0.02}, hint="waqfMuanaqa")
            for ident, x in ((6, 12), (7, 8), (8, 10))
        ]
        marks = [
            found(1, 95, "above", fatha=0.05),
            found(2, 60, "below", ijamDot=0.03),
            found(3, 58, "above", sukun=0.04),
            found(4, 30, "below", ijamDot=0.03),
            found(5, 28, "above", fatha=0.05),
            *dots,
        ]
        check = check_word(text_marks("رَيْبَ", pause="ۛ"), [95, 60, 30], 90, marks)
        self.assertEqual({check.types[ident] for ident in (6, 7, 8)}, {"waqfMuanaqa"})
        self.assertTrue(check.clean)


class CompoundTests(TestCase):
    def test_a_pairs_name_does_not_depend_on_order(self):
        self.assertEqual(compound("kasra", "hamza"), "hamza+kasra")
        self.assertEqual(parts_of("hamza+kasra"), ["hamza", "kasra"])
        self.assertEqual(parts_of("fatha"), ["fatha"])

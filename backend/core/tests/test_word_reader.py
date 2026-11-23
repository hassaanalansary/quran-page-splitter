"""The word reader: one rule for a letter, a mark, a letter with its mark, pieces as one."""

from typing import ClassVar
from unittest import TestCase

from core.text import letters_of, paws, text_marks
from core.text.contents import ContentsKey
from core.word_boundary.habits import WordHabits, count_word_habits, make_empty_habit_counts
from core.word_boundary.mark_check import FoundMark
from core.word_boundary.word_reader import BodyPiece, WordText, read_word


def word_text(text: str) -> WordText:
    return WordText(letters_of(text), tuple(paws(text)), tuple(text_marks(text)))


def key(text: str) -> ContentsKey:
    bodies, marks = text.split(":")
    return ContentsKey(tuple(bodies.split("+")) if bodies else (), tuple(marks.split("+")) if marks else ())


class QalooTests(TestCase):
    """قَالُوا۟ — قا | لو | ا, a round zero on the last alef."""

    text = word_text("قَالُوا۟")
    marks: ClassVar[list[FoundMark]] = [
        FoundMark(10, 95, "above", scores={"ijamDot": 0.05, "fatha": 0.4}),
        FoundMark(11, 85, "above", scores={"fatha": 0.05, "damma": 0.4}),
        FoundMark(12, 55, "above", scores={"damma": 0.05, "fatha": 0.4}),
    ]

    def bodies(self, alef: dict[ContentsKey, float]) -> list[BodyPiece]:
        return [
            BodyPiece(1, right=100, left=70),
            BodyPiece(2, right=65, left=40),
            BodyPiece(3, right=30, left=25, distances=alef),
        ]

    def test_an_alef_that_looks_like_it_holds_its_round_zero_is_read_so(self):
        alef = {key("ا:roundZero"): 0.1, key("ا:"): 0.5}
        reading = read_word(self.text, self.bodies(alef), self.marks, width=75, habits=make_empty_habit_counts())
        self.assertEqual(reading.keys[3], key("ا:roundZero"))
        self.assertEqual(reading.keys[1], key("قا:"))
        self.assertEqual(reading.keys[11], key(":fatha"))
        self.assertEqual(reading.check.missing, [])

    def test_a_round_zero_printed_apart_stays_a_mark_of_its_own(self):
        alef = {key("ا:roundZero"): 0.5, key("ا:"): 0.1}
        ring = FoundMark(13, 27, "above", scores={"roundZero": 0.05, "sukun": 0.3})
        reading = read_word(
            self.text, self.bodies(alef), [*self.marks, ring], width=75, habits=make_empty_habit_counts()
        )
        self.assertEqual(reading.keys[3], key("ا:"))
        self.assertEqual(reading.keys[13], key(":roundZero"))

    def test_a_person_who_said_nothing_touches_is_never_overruled(self):
        alef = {key("ا:roundZero"): 0.1, key("ا:"): 0.5}
        bodies = self.bodies(alef)
        bodies[2] = BodyPiece(3, right=30, left=25, decided=key("ا:"), distances=alef)
        reading = read_word(self.text, bodies, self.marks, width=75, habits=make_empty_habit_counts())
        self.assertEqual(reading.keys[3], key("ا:"))

    def test_a_person_who_said_it_touches_is_believed_with_no_pictures_at_all(self):
        bodies = self.bodies({})
        bodies[2] = BodyPiece(3, right=30, left=25, decided=ContentsKey(("ا",), ("roundZero",)))
        reading = read_word(self.text, bodies, self.marks, width=75, habits=make_empty_habit_counts())
        self.assertEqual(reading.keys[3], key("ا:roundZero"))


class PackingTests(TestCase):
    def test_one_body_for_two_pieces_holds_both(self):
        reading = read_word(
            word_text("إِلَّا"), [BodyPiece(1, right=40, left=0)], [], width=40, habits=make_empty_habit_counts()
        )
        self.assertEqual(reading.keys[1], key("إ+لا:"))

    def test_the_hands_habit_makes_a_join_cheap(self):
        habits = make_empty_habit_counts()
        for _ in range(5):
            count_word_habits(habits, WordHabits("إلا", ("إ", "لا"), (True,), ()))
        fused = read_word(word_text("إِلَّا"), [BodyPiece(1, right=40, left=0)], [], width=40, habits=habits)
        unseen = read_word(
            word_text("إِلَّا"), [BodyPiece(1, right=40, left=0)], [], width=40, habits=make_empty_habit_counts()
        )
        self.assertLess(fused.cost, unseen.cost)

    def test_decided_letters_choose_the_packing(self):
        bodies = [BodyPiece(1, right=100, left=60, decided=key("قا+لو:")), BodyPiece(2, right=50, left=40)]
        reading = read_word(word_text("قَالُوا۟"), bodies, [], width=60, habits=make_empty_habit_counts())
        self.assertEqual(reading.keys[1], key("قا+لو:"))
        self.assertEqual(reading.keys[2], key("ا:"))

    def test_a_word_read_one_way_only_is_sure_and_two_ways_alike_is_not(self):
        habits = make_empty_habit_counts()
        # The letters alone, no marks named: only the packing decides.
        bare = WordText("قالوا", ("قا", "لو", "ا"), ())
        three = [BodyPiece(1, right=100, left=70), BodyPiece(2, right=65, left=40), BodyPiece(3, right=30, left=25)]
        clear = read_word(bare, three, [], width=75, habits=habits)
        two = [BodyPiece(1, right=100, left=55), BodyPiece(2, right=50, left=25)]
        doubtful = read_word(bare, two, [], width=75, habits=habits)
        self.assertGreater(clear.gap, doubtful.gap)
        self.assertFalse(clear.unsure)
        self.assertTrue(doubtful.unsure)

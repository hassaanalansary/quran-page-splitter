"""The hand's habits: counted per word, per letter pair and everywhere, asked narrowest first."""

from unittest import TestCase

from core.word_boundary.habits import (
    JOIN_PRIOR,
    WordHabits,
    add_habit_counts,
    chance_of_mark_place,
    chance_of_touching,
    count_word_habits,
    expect_mark_places,
    make_empty_habit_counts,
)

ILLA = WordHabits("إلا", ("إ", "لا"), (True,), ())
ILA = WordHabits("إلى", ("إ", "لى"), (False,), ())
QALOO = WordHabits("قالوا", ("قا", "لو", "ا"), (False, False), ((4, "roundZero", "inside"),))


class JoinTests(TestCase):
    def test_a_word_seen_often_enough_speaks_for_itself(self):
        counts = make_empty_habit_counts()
        for _ in range(5):
            count_word_habits(counts, ILLA)
        for _ in range(6):
            count_word_habits(counts, ILA)
        # The letters إ and ل alone would pool them, 5 in 11.
        self.assertGreater(chance_of_touching(counts, "إلا", ("إ", "لا"), 0), 0.7)
        self.assertLess(chance_of_touching(counts, "إلى", ("إ", "لى"), 0), 0.05)

    def test_a_word_seen_less_falls_back_to_its_letters(self):
        counts = make_empty_habit_counts()
        for _ in range(5):
            count_word_habits(counts, ILLA)
        # إلاه has never been seen: the pair إ|ل has, five times, all touching.
        self.assertGreater(chance_of_touching(counts, "إلاه", ("إ", "لا", "ه"), 0), 0.7)

    def test_nothing_seen_is_the_prior(self):
        self.assertEqual(chance_of_touching(make_empty_habit_counts(), "إلا", ("إ", "لا"), 0), JOIN_PRIOR)


class MarkTests(TestCase):
    def test_marks_by_where_they_went(self):
        counts = make_empty_habit_counts()
        for _ in range(4):
            count_word_habits(counts, QALOO)
        prior = expect_mark_places(optional=False)
        # Seen four times in قالوا: under the word's own key, enough.
        self.assertGreater(chance_of_mark_place(counts, "قالوا", 4, "roundZero", "inside", prior), 0.6)
        # Another word ending in ا: the pair ا|roundZero has four, short of five, so every round zero speaks.
        self.assertGreater(chance_of_mark_place(counts, "كانوا", 4, "roundZero", "inside", prior), 0.6)


class AddingTests(TestCase):
    def test_a_page_added_and_taken_off_leaves_nothing(self):
        page = make_empty_habit_counts()
        count_word_habits(page, ILLA)
        count_word_habits(page, QALOO)
        total = make_empty_habit_counts()
        add_habit_counts(total, page)
        self.assertEqual(total["joins"]["word"]["إلا|0"], [1, 0])
        add_habit_counts(total, page, sign=-1)
        self.assertEqual(total, make_empty_habit_counts())

    def test_taking_a_word_off_removes_its_keys(self):
        counts = make_empty_habit_counts()
        count_word_habits(counts, ILLA)
        count_word_habits(counts, ILLA, sign=-1)
        self.assertEqual(counts, make_empty_habit_counts())

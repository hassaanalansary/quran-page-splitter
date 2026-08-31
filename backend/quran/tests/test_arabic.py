"""Tests for core.arabic — what a word's spelling says about its ink.

These rules decide how many blobs the boundary engine expects a word to make, and
they fill ``Word.paw_count``, so a change here moves every word cut in the mushaf.
"""

from django.test import SimpleTestCase

from core.arabic import ijam_groups, letters_of, paw_count, paws


class PawCountTests(SimpleTestCase):
    def test_breaks_after_a_non_joiner_and_nowhere_else(self):
        # دار: the alef does not join forwards, so the word breaks after it.
        self.assertEqual(paws("دار"), ["د", "ا", "ر"])
        self.assertEqual(paw_count("دار"), 3)

    def test_joins_run_together(self):
        self.assertEqual(paw_count("يستعين"), 1)

    def test_marks_never_split_a_word(self):
        """Tashkeel sits above and below the line; it is no part of the skeleton."""
        self.assertEqual(paw_count("نَسْتَعِينُ"), paw_count("نستعين"))
        self.assertEqual(letters_of("نَسْتَعِينُ"), "نستعين")

    def test_uthmani_not_imlaei(self):
        """The recorded trap: the two scripts disagree, and only one is right here.

        ``إصلاحها`` scores 2 in Uthmani (which writes it ``إِصْلَٰحِهَا``, the middle
        alef a dagger above the line) and 3 in imlaei, which writes that alef as a
        letter and so breaks the word again. That is why the seed reads the
        uthmani download and never simple-clean.
        """
        self.assertEqual(paw_count("إِصْلَٰحِهَا"), 2)
        self.assertEqual(paw_count("إصلاحها"), 3)

    def test_never_zero(self):
        self.assertEqual(paw_count(""), 1)

    def test_tatweel_stretches_a_join_rather_than_breaking_it(self):
        self.assertEqual(paw_count("ٱلْمَشْـَٔمَةِ"), paw_count("ٱلْمَشْئَمَةِ"))


class IjamTests(SimpleTestCase):
    def test_counts_groups_not_dots(self):
        """``ت`` carries two dots, drawn as one blob — one group, not two."""
        self.assertEqual(ijam_groups("ت"), (1, 0))
        self.assertEqual(ijam_groups("ث"), (1, 0))

    def test_above_and_below_are_separate(self):
        self.assertEqual(ijam_groups("ب"), (0, 1))
        self.assertEqual(ijam_groups("ن"), (1, 0))
        self.assertEqual(ijam_groups("بن"), (1, 1))

    def test_undotted_letters_impose_nothing(self):
        self.assertEqual(ijam_groups("ٱلْحَمْدُ"), (0, 0))

    def test_hamza_seats_carry_no_dots(self):
        """The hamza replaces them, which is why ``ئ`` and ``ؤ`` are not in IJAM."""
        self.assertEqual(ijam_groups("ئ"), (0, 0))
        self.assertEqual(ijam_groups("ؤ"), (0, 0))

"""Counting the pieces of a text, as the library's keys spell them."""

from unittest import TestCase

from core.text.paw_inventory import count_paws_of_words

#: The opening of Al-Fatiha, as the Tanzil Uthmani text writes it.
FATIHA_OPENING = ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحْمَـٰنِ", "ٱلرَّحِيمِ", "ٱلْحَمْدُ", "لِلَّهِ", "رَبِّ", "ٱلْعَـٰلَمِينَ"]


class CountPawsTests(TestCase):
    def test_each_piece_is_counted_as_spelled(self):
        counts = count_paws_of_words(FATIHA_OPENING)
        self.assertEqual(counts["ٱ"], 5)
        self.assertEqual(counts["لر"], 2)
        self.assertEqual(counts["لله"], 2)
        for single in ("بسم", "حمن", "حيم", "لحمد", "ر", "ب", "لعلمين"):
            self.assertEqual(counts[single], 1, single)
        self.assertEqual(sum(counts.values()), 16)

    def test_runs_of_pieces_inside_a_word(self):
        counts = count_paws_of_words(["إِلَّا", "إِلَّا", "إِلَىٰ"], longest_run=2)
        self.assertEqual(counts["إ+لا"], 2)
        self.assertEqual(counts["إ+لى"], 1)
        self.assertEqual(counts["إ"], 3)

    def test_runs_never_cross_a_word(self):
        counts = count_paws_of_words(["مَا", "لَا"], longest_run=2)
        self.assertNotIn("ما+لا", counts)

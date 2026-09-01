"""Tests for quran.services.words — the word stream the engine aligns against.

The point of this layer is that it answers per *counting system*. A test that only
ever asks Kufi would pass with the whole thing hard-wired to Hafs, so the ones that
matter here compare two systems.
"""

from django.test import TestCase

from core.quran_text import load_ayat
from core.word_boundary import words_from_ayat
from quran.models import CountingSystem
from quran.services import words
from quran.services.quran_text import DEFAULT_QURAN_TEXT_PATH
from quran.services.seeding import seed_quran_text
from quran.services.suras import seed_reference_data


class WordStreamTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        seed_quran_text()
        cls.kufi = CountingSystem.objects.get(name="Kufi")
        cls.basran = CountingSystem.objects.get(name="Basran")

    def test_the_same_request_gives_different_words_in_different_systems(self):
        """The whole reason this goes through a counting system.

        Al-A'raf 82 is not the same aya in Kufi as in Basran — they divide the
        sura differently — so a mushaf printed in a Basran riwaya must be handed
        different words for the same request, or every cut on the page is wrong.
        """
        kufi = words.word_stream(self.kufi, start=(7, 82), end=(7, 84))
        basran = words.word_stream(self.basran, start=(7, 82), end=(7, 84))
        self.assertNotEqual(kufi[0].id, basran[0].id)
        self.assertNotEqual(len(kufi), len(basran))

    def test_al_fatiha_splits_where_the_system_says(self):
        kufi = words.word_stream(self.kufi, start=(1, 1), end=(1, 7))
        basran = words.word_stream(self.basran, start=(1, 1), end=(1, 7))
        # Same 29 words either way — the sura is the sura — but grouped differently.
        self.assertEqual(len(kufi), len(basran))
        self.assertEqual(kufi[0].aya, "1:1")
        # Kufi calls the basmala aya 1; Basran runs it into what Kufi calls aya 2.
        self.assertEqual(kufi[4].aya, "1:2")
        self.assertEqual(basran[4].aya, "1:1")

    def test_every_word_is_labelled_with_its_aya(self):
        stream = words.word_stream(self.kufi, start=(1, 1), end=(1, 2))
        self.assertEqual([w.aya for w in stream], ["1:1"] * 4 + ["1:2"] * 4)

    def test_carries_the_counts_the_engine_needs(self):
        # بسم = 1 blob; الله breaks after its alef = 2; الرحمن and الرحيم break
        # after the alef and again after the ra = 3 each.
        stream = words.word_stream(self.kufi, start=(1, 1), end=(1, 1))
        self.assertEqual([w.paws for w in stream], [1, 2, 3, 3])
        self.assertTrue(all(w.id is not None for w in stream))

    def test_agrees_with_the_file_backed_adapter(self):
        """The database and ``words_from_ayat`` must not drift apart.

        Both fill these counts from ``core.arabic``; if they ever disagree, the CLI
        and the app would align the same page against different expectations.
        """
        ayat = [a for a in load_ayat(DEFAULT_QURAN_TEXT_PATH) if a.sura == 1]
        from_file = words_from_ayat(ayat)
        from_db = words.word_stream(self.kufi, start=(1, 1), end=(1, 7))
        self.assertEqual(
            [(w.text, w.paws, w.ijam_above, w.ijam_below, w.aya) for w in from_file],
            [(w.text, w.paws, w.ijam_above, w.ijam_below, w.aya) for w in from_db],
        )

    def test_an_aya_missing_from_a_system_says_which_system(self):
        with self.assertRaises(LookupError) as caught:
            words.word_stream(self.basran, start=(7, 82), end=(7, 206))
        self.assertIn("Basran", str(caught.exception))

    def test_a_backwards_span_is_refused(self):
        with self.assertRaises(LookupError):
            words.word_stream(self.kufi, start=(7, 84), end=(7, 82))

    def test_sura_last_aya_is_per_system(self):
        self.assertEqual(words.sura_last_aya(self.kufi, 7), 206)
        self.assertNotEqual(words.sura_last_aya(self.basran, 7), 206)

    def test_the_last_aya_of_the_quran_has_an_end(self):
        """``Aya`` stores no end, so the final one has to fall back to the last word."""
        stream = words.word_stream(self.kufi, start=(114, 6), end=(114, 6))
        self.assertTrue(stream)
        self.assertEqual(stream[-1].id, 77_433)

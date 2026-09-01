"""Tests for core.quran_text — reading Tanzil into ayat and words.

The word numbering the whole app hangs off starts here, so the basmala rule is
worth pinning: get it wrong by four words in one sura and every word index after
it is wrong too.
"""

from django.test import SimpleTestCase

from core.arabic import letters_of
from core.quran_text import BASMALA_LETTERS, drop_leading_basmala, load_ayat, span
from quran.services.quran_text import DEFAULT_QURAN_TEXT_PATH

BASMALA = ["بِسْمِ", "ٱللَّهِ", "ٱلرَّحْمَٰنِ", "ٱلرَّحِيمِ"]

_ALEF_FOLD = str.maketrans(dict.fromkeys("أإآٱٲٳٵ", "ا"))


def _skeleton(words: list[str]) -> str:
    """The words' letters, run together — no marks, every alef the same alef."""
    return "".join(letters_of(w) for w in words).translate(_ALEF_FOLD)


class DropLeadingBasmalaTests(SimpleTestCase):
    def test_removes_a_basmala_at_the_start(self):
        self.assertEqual(drop_leading_basmala([*BASMALA, "الٓمٓ"]), ["الٓمٓ"])

    def test_leaves_a_basmala_that_is_not_at_the_start(self):
        """27:30 ends with one, and there it is Quranic text that must survive."""
        words = ["إِنَّهُۥ", "مِن", "سُلَيْمَٰنَ", *BASMALA]
        self.assertEqual(drop_leading_basmala(words), words)

    def test_leaves_an_aya_that_is_only_a_basmala(self):
        """Nothing to strip when there is no aya left underneath it."""
        self.assertEqual(drop_leading_basmala(BASMALA), BASMALA)


class LoadAyatTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ayat = load_ayat(DEFAULT_QURAN_TEXT_PATH)

    def test_reads_every_kufi_aya(self):
        self.assertEqual(len(self.ayat), 6236)

    def test_word_total(self):
        self.assertEqual(sum(len(a.words) for a in self.ayat), 77_433)

    def test_strips_the_prepended_basmala_everywhere_but_suras_1_and_9(self):
        # Compared by letters, not by bytes: the same word can be written with its
        # marks in a different order, and that is not what this test is about.
        first = {a.sura: _skeleton(a.words) for a in self.ayat if a.number == 1}
        # Sura 1: the basmala genuinely is aya 1, so it stays.
        self.assertEqual(first[1], BASMALA_LETTERS)
        # Sura 2: Tanzil prepends it; the mushaf prints it on a line of its own.
        self.assertEqual(first[2], "الم")
        # Sura 9 has none to begin with, so there is nothing to strip.
        self.assertFalse(first[9].startswith(BASMALA_LETTERS))

    def test_no_sura_still_opens_with_a_basmala(self):
        opening = {a.sura: _skeleton(a.words) for a in self.ayat if a.number == 1}
        still_prefixed = [s for s, text in opening.items() if s != 1 and text.startswith(BASMALA_LETTERS)]
        self.assertEqual(still_prefixed, [])

    def test_strips_exactly_112(self):
        """114 suras, less sura 9 which has no basmala and sura 1 where it is aya 1."""
        raw = load_ayat(DEFAULT_QURAN_TEXT_PATH, strip_basmala=False)
        self.assertEqual(sum(len(a.words) for a in raw) - 77_433, 112 * 4)


class SpanTests(SimpleTestCase):
    """``span`` is what the CLI resolves a --from/--to pair with.

    It replaced a second copy of this whole loader that lived in the prototype
    only because it needed this one function. With one loader there is nothing
    left to drift.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.ayat = load_ayat(DEFAULT_QURAN_TEXT_PATH)

    def test_is_inclusive_at_both_ends(self):
        got = span(self.ayat, (7, 82), (7, 84))
        self.assertEqual([(a.sura, a.number) for a in got], [(7, 82), (7, 83), (7, 84)])

    def test_one_aya(self):
        self.assertEqual(len(span(self.ayat, (1, 1), (1, 1))), 1)

    def test_crosses_a_sura_boundary(self):
        """Recitation order, not sura order — a page does not stop at a sura."""
        got = span(self.ayat, (7, 206), (8, 2))
        self.assertEqual([(a.sura, a.number) for a in got], [(7, 206), (8, 1), (8, 2)])

    def test_an_aya_that_is_not_there_says_which(self):
        with self.assertRaises(LookupError) as caught:
            span(self.ayat, (7, 82), (7, 999))
        self.assertIn("7:999", str(caught.exception))

    def test_backwards_is_refused(self):
        with self.assertRaises(LookupError):
            span(self.ayat, (7, 84), (7, 82))

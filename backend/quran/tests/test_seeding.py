"""Tests for the word list and the six systems' aya maps.

The seeder runs its own checks and refuses to commit when one fails, so these
tests are mostly about proving those checks are actually reached and that the
result says what it should about a real disagreement between counting systems.
"""

from django.test import TestCase

from quran.models import Aya, CountingSystem, Sura, SuraAyaCount, Word
from quran.services.seeding import (
    EXPECTED_AYA_TOTALS,
    EXPECTED_PAWS,
    EXPECTED_WORDS,
    seed_quran_text,
    validate,
)
from quran.services.suras import seed_reference_data


class SeedQuranTests(TestCase):
    """One seed, shared by every assertion — it writes 114,746 rows."""

    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        cls.words, cls.ayat, cls.problems = seed_quran_text()

    def test_every_check_passes(self):
        self.assertEqual(self.problems, [])

    def test_word_count_and_paw_total(self):
        self.assertEqual(self.words, EXPECTED_WORDS)
        self.assertEqual(Word.objects.count(), EXPECTED_WORDS)
        self.assertEqual(sum(Word.objects.values_list("paw_count", flat=True)), EXPECTED_PAWS)

    def test_words_are_numbered_from_one_without_gaps(self):
        self.assertEqual(Word.objects.order_by("id").first().id, 1)
        self.assertEqual(Word.objects.order_by("-id").first().id, EXPECTED_WORDS)

    def test_every_system_reaches_its_published_total(self):
        actual = {name: Aya.objects.filter(counting_system__name=name).count() for name in EXPECTED_AYA_TOTALS}
        self.assertEqual(actual, EXPECTED_AYA_TOTALS)
        self.assertEqual(self.ayat, sum(EXPECTED_AYA_TOTALS.values()))

    def test_agrees_with_the_independently_seeded_sura_counts(self):
        """684 counts from a source unrelated to the boundary deltas."""
        mismatches = []
        for sura, system, count in SuraAyaCount.objects.values_list("sura_id", "counting_system__name", "count"):
            built = Aya.objects.filter(sura_id=sura, counting_system__name=system).count()
            if built != count:
                mismatches.append((sura, system, built, count))
        self.assertEqual(mismatches, [])

    def test_suras_start_at_the_same_word_in_every_system(self):
        """Counting systems move aya boundaries, never sura boundaries."""
        starts: dict[int, set[int]] = {}
        for sura, start in Aya.objects.filter(number=1).values_list("sura_id", "start_word_id"):
            starts.setdefault(sura, set()).add(start)
        self.assertEqual(len(starts), Sura.objects.count())
        self.assertEqual([s for s, v in starts.items() if len(v) > 1], [])

    def test_reseeding_is_stable(self):
        words, ayat, problems = seed_quran_text()
        self.assertEqual((words, ayat, problems), (EXPECTED_WORDS, self.ayat, []))


class CrossSystemDifferenceTests(TestCase):
    """The point of the whole table: same sura, same count, different boundaries.

    Al-Fatiha is seven ayat in all six systems, but Kufi and Makkan count the
    basmala as aya 1 while the Madinan, Basran and Damascene systems do not — they
    run it into what Kufi calls aya 2, and win the aya back by splitting Kufi's
    aya 7 after ``أنعمت عليهم``.
    """

    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        seed_quran_text()

    def _starts(self, system: str) -> list[int]:
        return list(
            Aya.objects.filter(counting_system__name=system, sura_id=1)
            .order_by("number")
            .values_list("start_word_id", flat=True)
        )

    def test_kufi_counts_the_basmala_as_aya_one(self):
        self.assertEqual(self._starts("Kufi"), [1, 5, 9, 11, 14, 18, 21])

    def test_makkan_agrees_with_kufi_here(self):
        self.assertEqual(self._starts("Makkan"), self._starts("Kufi"))

    def test_basran_merges_the_basmala_and_splits_the_last_aya(self):
        # Aya 1 runs to word 8, so aya 2 opens at 9; and Kufi's aya 7 (21..29)
        # becomes two, split after word 24 — صراط الذين أنعمت عليهم.
        self.assertEqual(self._starts("Basran"), [1, 9, 11, 14, 18, 21, 25])

    def test_all_six_still_count_seven(self):
        counts = {
            name: Aya.objects.filter(counting_system__name=name, sura_id=1).count() for name in EXPECTED_AYA_TOTALS
        }
        self.assertEqual(set(counts.values()), {7})

    def test_the_split_lands_on_the_right_word(self):
        basran_last = Aya.objects.get(counting_system__name="Basran", sura_id=1, number=7)
        self.assertEqual(Word.objects.get(id=basran_last.start_word_id - 1).text, "عَلَيْهِمْ")
        self.assertEqual(Word.objects.get(id=basran_last.start_word_id).text, "غَيْرِ")


class ValidationTests(TestCase):
    """The checks have to fail when the data is wrong, or they prove nothing."""

    @classmethod
    def setUpTestData(cls):
        seed_reference_data()
        seed_quran_text()

    def test_notices_a_missing_aya(self):
        from quran.services.seeding import index_words

        Aya.objects.filter(counting_system__name="Kufi", sura_id=114, number=6).delete()
        problems = validate(index_words())
        self.assertTrue(any("Kufi" in p for p in problems), problems)

    def test_notices_a_moved_sura_start(self):
        from quran.services.seeding import index_words

        aya = Aya.objects.get(counting_system__name="Basran", sura_id=2, number=1)
        aya.start_word_id += 1
        aya.save(update_fields=["start_word"])
        problems = validate(index_words())
        self.assertTrue(any("sura 2" in p for p in problems), problems)

    def test_notices_a_lost_counting_system(self):
        from quran.services.seeding import index_words

        CountingSystem.objects.filter(name="Makkan").delete()  # cascades to its ayat
        problems = validate(index_words())
        self.assertTrue(any("Makkan" in p for p in problems), problems)

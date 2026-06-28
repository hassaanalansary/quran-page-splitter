"""Tests for api.services.suras (reference data)."""

from django.test import TestCase

from api.models import CountingSystem, Qiraa, Sura, SuraAyaCount
from api.services import suras

KUFI_ARABIC = "الكوفي"


class SeedReferenceDataTests(TestCase):
    def test_seeds_suras_and_counting_systems(self):
        suras.seed_reference_data()
        self.assertEqual(Sura.objects.count(), 114)
        self.assertEqual(CountingSystem.objects.count(), len(suras.COUNTING_SYSTEM_BY_SLUG))
        # 114 suras x every counting system in the JSON.
        self.assertEqual(SuraAyaCount.objects.count(), 114 * len(suras.COUNTING_SYSTEM_BY_SLUG))

    def test_known_counts(self):
        suras.seed_reference_data()
        fatiha = Sura.objects.get(number=1)
        self.assertEqual(fatiha.transliteration, "Al-Fatiha")
        count = SuraAyaCount.objects.get(sura=fatiha, counting_system__name_arabic=KUFI_ARABIC).count
        self.assertEqual(count, 7)

    def test_idempotent(self):
        suras.seed_reference_data()
        suras.seed_reference_data()
        self.assertEqual(Sura.objects.count(), 114)
        self.assertEqual(CountingSystem.objects.count(), len(suras.COUNTING_SYSTEM_BY_SLUG))
        self.assertEqual(SuraAyaCount.objects.count(), 114 * len(suras.COUNTING_SYSTEM_BY_SLUG))


class ListSurasTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        kufi = CountingSystem.objects.get(name_arabic=KUFI_ARABIC)
        Qiraa.objects.create(name="hafs", name_arabic="حفص", counting_system=kufi)

    def test_returns_all_with_counts(self):
        result = suras.list_suras("hafs")
        self.assertEqual(len(result), 114)
        self.assertEqual(result[0]["number"], 1)
        self.assertEqual(result[0]["transliteration"], "Al-Fatiha")
        self.assertEqual(result[0]["aya_count"], 7)

    def test_case_insensitive_qiraa(self):
        self.assertEqual(suras.list_suras("HAFS")[0]["aya_count"], 7)

    def test_unknown_qiraa_yields_null_counts(self):
        result = suras.list_suras("nonexistent")
        self.assertEqual(len(result), 114)
        self.assertIsNone(result[0]["aya_count"])

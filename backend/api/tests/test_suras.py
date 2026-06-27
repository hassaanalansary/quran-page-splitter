"""Tests for api.services.suras (reference data)."""

from django.test import TestCase

from api.models import Qiraa, Sura, SuraAyaCount
from api.services import suras


class SeedReferenceDataTests(TestCase):
    def test_seeds_all_suras(self):
        suras.seed_reference_data()
        self.assertEqual(Sura.objects.count(), 114)
        self.assertEqual(SuraAyaCount.objects.filter(qiraa__name="hafs").count(), 114)
        self.assertTrue(Qiraa.objects.filter(name="hafs").exists())

    def test_known_counts(self):
        suras.seed_reference_data()
        fatiha = Sura.objects.get(number=1)
        self.assertEqual(fatiha.transliteration, "Al-Fatiha")
        count = SuraAyaCount.objects.get(sura=fatiha, qiraa__name="hafs").count
        self.assertEqual(count, 7)

    def test_idempotent(self):
        suras.seed_reference_data()
        suras.seed_reference_data()
        self.assertEqual(Sura.objects.count(), 114)
        self.assertEqual(SuraAyaCount.objects.count(), 114)


class ListSurasTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_returns_all_with_counts(self):
        result = suras.list_suras("hafs")
        self.assertEqual(len(result), 114)
        self.assertEqual(result[0]["number"], 1)
        self.assertEqual(result[0]["transliteration"], "Al-Fatiha")
        self.assertEqual(result[0]["aya_count"], 7)

    def test_unknown_qiraa_yields_null_counts(self):
        result = suras.list_suras("nonexistent")
        self.assertEqual(len(result), 114)
        self.assertIsNone(result[0]["aya_count"])

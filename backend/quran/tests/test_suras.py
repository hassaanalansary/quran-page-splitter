"""Tests for quran.services.suras (reference data)."""

import json

from django.test import TestCase

from quran.models import CountingSystem, Qiraa, Rawi, Sura, SuraAyaCount
from quran.services import suras

KUFI_NAME = "Kufi"

# The committed snapshot the seed reads — assert against its own contents so the
# tests track the real reference data instead of hard-coded totals.
REFERENCE_DATA = json.loads(suras.REFERENCE_DATA_PATH.read_text(encoding="utf-8"))


class SeedReferenceDataTests(TestCase):
    def test_seeds_every_reference_table(self):
        suras.seed_reference_data()
        self.assertEqual(CountingSystem.objects.count(), len(REFERENCE_DATA["counting_systems"]))
        self.assertEqual(Qiraa.objects.count(), len(REFERENCE_DATA["qiraat"]))
        self.assertEqual(Rawi.objects.count(), len(REFERENCE_DATA["rawis"]))
        self.assertEqual(Sura.objects.count(), len(REFERENCE_DATA["suras"]))
        self.assertEqual(SuraAyaCount.objects.count(), len(REFERENCE_DATA["aya_counts"]))

    def test_seeds_rawis_under_qiraat_with_counting_system(self):
        """The chain the whole app reads: rawi -> qiraa -> counting system."""
        suras.seed_reference_data()
        hafs = Rawi.objects.select_related("qiraa__counting_system").get(name__iexact="hafs")
        self.assertEqual(hafs.qiraa.name, "Asim")
        self.assertEqual(hafs.counting_system.name, KUFI_NAME)

    def test_both_rawis_of_a_qiraa_share_its_counting_system(self):
        suras.seed_reference_data()
        systems = {r.counting_system.name for r in Rawi.objects.filter(qiraa__name="Nafi")}
        self.assertEqual(systems, {"Last Madinan"})

    def test_known_counts(self):
        suras.seed_reference_data()
        fatiha = Sura.objects.get(number=1)
        self.assertEqual(fatiha.transliteration, "Al-Fatiha")
        count = SuraAyaCount.objects.get(sura=fatiha, counting_system__name=KUFI_NAME).count
        self.assertEqual(count, 7)

    def test_idempotent(self):
        suras.seed_reference_data()
        suras.seed_reference_data()
        self.assertEqual(CountingSystem.objects.count(), len(REFERENCE_DATA["counting_systems"]))
        self.assertEqual(Qiraa.objects.count(), len(REFERENCE_DATA["qiraat"]))
        self.assertEqual(Rawi.objects.count(), len(REFERENCE_DATA["rawis"]))
        self.assertEqual(Sura.objects.count(), len(REFERENCE_DATA["suras"]))
        self.assertEqual(SuraAyaCount.objects.count(), len(REFERENCE_DATA["aya_counts"]))


class ListSurasTests(TestCase):
    def setUp(self):
        # Seeding creates the rawis too, so fetch (don't recreate) the hafs row.
        suras.seed_reference_data()

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

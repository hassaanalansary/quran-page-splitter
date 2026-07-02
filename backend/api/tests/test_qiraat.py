"""Tests for api.services.qiraat (reference data)."""

from django.test import TestCase

from api.models import CountingSystem, Qiraa
from api.services import qiraat


class ListQiraatTests(TestCase):
    def _seed(self):
        kufi = CountingSystem.objects.create(name="Kufan", name_arabic="الكوفي")
        Qiraa.objects.create(name="warsh", name_arabic="ورش", counting_system=kufi)
        Qiraa.objects.create(name="Hafs", name_arabic="حفص", counting_system=kufi)
        Qiraa.objects.create(name="duri", name_arabic="الدوري")  # no counting system

    def test_lists_all_ordered_case_insensitively(self):
        self._seed()
        # Binary ordering would give ["Hafs", "duri", "warsh"]; case-insensitive interleaves.
        self.assertEqual([q["name"] for q in qiraat.list_qiraat()], ["duri", "Hafs", "warsh"])

    def test_english_default_carries_counting_system(self):
        self._seed()
        hafs = next(q for q in qiraat.list_qiraat() if q["name"] == "Hafs")
        self.assertEqual(hafs, {"name": "Hafs", "counting_system": "Kufan"})

    def test_arabic_lang_switches_both_labels(self):
        self._seed()
        hafs = next(q for q in qiraat.list_qiraat(lang="ar") if q["name"] == "حفص")
        self.assertEqual(hafs["counting_system"], "الكوفي")

    def test_missing_counting_system_is_blank(self):
        self._seed()
        duri = next(q for q in qiraat.list_qiraat() if q["name"] == "duri")
        self.assertEqual(duri["counting_system"], "")

    def test_empty_when_none(self):
        self.assertEqual(qiraat.list_qiraat(), [])

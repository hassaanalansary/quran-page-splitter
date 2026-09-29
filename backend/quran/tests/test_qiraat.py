"""Tests for quran.services.qiraat (reference data).

What the picker lists is the twenty rawis; ``qiraa`` and ``counting_system`` are
labels read through the rawi's qiraa. The wire name of a rawi is ``name`` and is
stored on mushafs and inside exported bundles, so these tests pin that shape.
"""

from django.test import TestCase

from quran.models import CountingSystem, Qiraa, Rawi
from quran.services import qiraat


class ListQiraatTests(TestCase):
    def _seed(self):
        kufi = CountingSystem.objects.create(name="Kufan", name_arabic="الكوفي")
        asim = Qiraa.objects.create(name="Asim", name_arabic="عاصم", counting_system=kufi)
        nafi = Qiraa.objects.create(name="Nafi", name_arabic="نافع")  # no counting system
        Rawi.objects.create(name="warsh", name_arabic="ورش", qiraa=nafi)
        Rawi.objects.create(name="Hafs", name_arabic="حفص", qiraa=asim)
        Rawi.objects.create(name="duri", name_arabic="الدوري")  # no qiraa at all

    def test_lists_all_ordered_case_insensitively(self):
        self._seed()
        # Binary ordering would give ["Hafs", "duri", "warsh"]; case-insensitive interleaves.
        self.assertEqual([q["name"] for q in qiraat.list_qiraat()], ["duri", "Hafs", "warsh"])

    def test_english_default_carries_qiraa_and_counting_system(self):
        self._seed()
        hafs = next(q for q in qiraat.list_qiraat() if q["name"] == "Hafs")
        self.assertEqual(hafs, {"name": "Hafs", "qiraa": "Asim", "counting_system": "Kufan"})

    def test_arabic_lang_switches_every_label(self):
        self._seed()
        hafs = next(q for q in qiraat.list_qiraat(lang="ar") if q["name"] == "حفص")
        self.assertEqual(hafs["qiraa"], "عاصم")
        self.assertEqual(hafs["counting_system"], "الكوفي")

    def test_counting_system_comes_from_the_qiraa(self):
        """A rawi has no counting system of its own — it reads through its qiraa."""
        self._seed()
        warsh = next(q for q in qiraat.list_qiraat() if q["name"] == "warsh")
        self.assertEqual(warsh["qiraa"], "Nafi")
        self.assertEqual(warsh["counting_system"], "")  # Nafi was seeded without one

    def test_missing_qiraa_leaves_both_labels_blank(self):
        self._seed()
        duri = next(q for q in qiraat.list_qiraat() if q["name"] == "duri")
        self.assertEqual(duri["qiraa"], "")
        self.assertEqual(duri["counting_system"], "")

    def test_empty_when_none(self):
        self.assertEqual(qiraat.list_qiraat(), [])

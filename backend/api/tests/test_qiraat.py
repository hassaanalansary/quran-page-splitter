"""Tests for api.services.qiraat (reference data)."""

from django.test import TestCase

from api.models import Qiraa
from api.services import qiraat


class ListQiraatTests(TestCase):
    def test_lists_all_ordered_case_insensitively(self):
        # Mixed casing on purpose: binary ordering would give ["Hafs", "duri", "warsh"];
        # case-insensitive ordering must interleave them as ["duri", "Hafs", "warsh"].
        Qiraa.objects.create(name="warsh", name_arabic="ورش")
        Qiraa.objects.create(name="Hafs", name_arabic="حفص")
        Qiraa.objects.create(name="duri", name_arabic="الدوري")

        result = qiraat.list_qiraat()

        self.assertEqual([q["name"] for q in result], ["duri", "Hafs", "warsh"])
        self.assertEqual(result[1], {"name": "Hafs", "name_arabic": "حفص"})

    def test_empty_when_none(self):
        self.assertEqual(qiraat.list_qiraat(), [])

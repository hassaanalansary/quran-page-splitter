"""Tests for api.validators (no DB; uses unsaved Mushaf instances)."""

from django.test import SimpleTestCase
from ninja.errors import HttpError

from api import validators
from api.models import Mushaf


def _mushaf(first: int, last: int) -> Mushaf:
    return Mushaf(first_quran_pdf_page=first, last_quran_pdf_page=last)


class LogicalPageCountTests(SimpleTestCase):
    def test_count(self):
        self.assertEqual(validators.logical_page_count(_mushaf(5, 10)), 6)
        self.assertEqual(validators.logical_page_count(_mushaf(1, 1)), 1)


class ValidatePdfBoundsTests(SimpleTestCase):
    def test_valid(self):
        validators.validate_pdf_bounds(1, 10, 10)  # does not raise

    def test_first_below_one(self):
        with self.assertRaises(HttpError):
            validators.validate_pdf_bounds(0, 10, 10)

    def test_first_after_last(self):
        with self.assertRaises(HttpError):
            validators.validate_pdf_bounds(8, 5, 10)

    def test_last_exceeds_total(self):
        with self.assertRaises(HttpError):
            validators.validate_pdf_bounds(1, 11, 10)


class ValidatePageNumberTests(SimpleTestCase):
    def test_valid(self):
        validators.validate_page_number(_mushaf(1, 10), 10)

    def test_out_of_range(self):
        with self.assertRaises(HttpError):
            validators.validate_page_number(_mushaf(1, 10), 11)
        with self.assertRaises(HttpError):
            validators.validate_page_number(_mushaf(1, 10), 0)


class ValidatePageRangeTests(SimpleTestCase):
    def test_valid(self):
        validators.validate_page_range(_mushaf(1, 10), 2, 8)

    def test_unordered(self):
        with self.assertRaises(HttpError):
            validators.validate_page_range(_mushaf(1, 10), 8, 2)

    def test_exceeds(self):
        with self.assertRaises(HttpError):
            validators.validate_page_range(_mushaf(1, 10), 1, 11)

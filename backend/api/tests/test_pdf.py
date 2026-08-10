"""Tests for api.services.pdf (pure helpers, no DB)."""

import hashlib
import tempfile
from pathlib import Path

from django.test import SimpleTestCase

from api.services import pdf
from api.tests.helpers import make_pdf_bytes


class Sha256Tests(SimpleTestCase):
    def test_matches_hashlib(self):
        data = b"quran-page-splitter"
        self.assertEqual(pdf.sha256_of(data), hashlib.sha256(data).hexdigest())

    def test_is_deterministic(self):
        data = make_pdf_bytes(2)
        self.assertEqual(pdf.sha256_of(data), pdf.sha256_of(data))


class PageCountTests(SimpleTestCase):
    def test_counts_pages(self):
        self.assertEqual(pdf.page_count(make_pdf_bytes(5)), 5)


class RenderPageTests(SimpleTestCase):
    def test_renders_png(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as handle:
            handle.write(make_pdf_bytes(3))
            path = handle.name
        try:
            png = pdf.render_page(path, 1)
        finally:
            Path(path).unlink()
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))


class LogicalToPdfIndexTests(SimpleTestCase):
    def test_offset_rule(self):
        self.assertEqual(pdf.logical_to_pdf_index(5, 1), 5)
        self.assertEqual(pdf.logical_to_pdf_index(5, 3), 7)

    def test_source_override_wins(self):
        self.assertEqual(pdf.logical_to_pdf_index(5, 3, source_pdf_page=99), 99)

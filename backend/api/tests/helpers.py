"""Shared test helpers: tiny PDF/PNG builders and a media-isolating TestCase."""

from __future__ import annotations

import io
import tempfile

import fitz  # PyMuPDF
from django.test import TestCase, override_settings
from PIL import Image

from api.models import Mushaf


def make_pdf_bytes(num_pages: int = 1) -> bytes:
    """Build a minimal in-memory PDF with the given number of pages."""
    doc = fitz.open()
    for i in range(num_pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Page {i + 1}")
    data: bytes = doc.tobytes()
    doc.close()
    return data


def make_png_bytes(size: tuple[int, int] = (20, 20)) -> bytes:
    """Build a tiny white PNG used as a stand-in template crop."""
    buffer = io.BytesIO()
    Image.new("RGB", size, (255, 255, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


class MediaTestCase(TestCase):
    """TestCase that isolates uploaded files into a throwaway MEDIA_ROOT."""

    _media_dir: tempfile.TemporaryDirectory[str]
    _media_override: override_settings

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls._media_dir = tempfile.TemporaryDirectory()
        cls._media_override = override_settings(MEDIA_ROOT=cls._media_dir.name)
        cls._media_override.enable()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._media_override.disable()
        cls._media_dir.cleanup()
        super().tearDownClass()


def bare_mushaf(name: str = "M", last_quran_pdf_page: int = 10) -> Mushaf:
    """A persisted Mushaf with no real PDF file (for tests that don't render)."""
    return Mushaf.objects.create(
        name=name,
        pdf_sha256="x",
        pdf_page_count=last_quran_pdf_page,
        first_quran_pdf_page=1,
        last_quran_pdf_page=last_quran_pdf_page,
    )

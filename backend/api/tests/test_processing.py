"""Tests for api.services.processing (guards + render→pipeline→persist wiring)."""

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import ProcessingRun
from api.services import mushaf as mushaf_service
from api.services import processing as processing_service
from api.services import suras
from api.tests.helpers import MediaTestCase, make_pdf_bytes, make_png_bytes

# Reasonable detection settings; acceleration off to use the CPU path in CI.
_SETTINGS = {
    "start_sura": 2,
    "start_aya": 1,
    "bounds": {"x": 50, "y": 50, "w": 500, "h": 500},
    "padding": 4,
    "expected_lines": 15,
    "sura_header_slots": 1,
    "sura_header_threshold": 0.6,
    "max_sura_headers": 3,
    "match_threshold": 0.5,
    "alternate_horizontal_margin": False,
    "prefer_acceleration": False,
}


def _mushaf(pages: int = 3):
    created = mushaf_service.create_mushaf(
        pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(pages), "application/pdf"),
        name="Proc",
        qiraa=None,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )
    return mushaf_service.get_mushaf(created["mushaf"]["id"])


def _add_templates(mushaf):
    for template_type in ("sura_header", "aya_separator"):
        mushaf_service.upsert_template(
            mushaf_id=mushaf.id,
            template_type=template_type,
            image=SimpleUploadedFile(
                f"{template_type}.png", make_png_bytes((40, 40)), "image/png"
            ),
            ignore_x=None,
            ignore_y=None,
            ignore_w=None,
            ignore_h=None,
        )


class ProcessGuardTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_missing_templates_rejected(self):
        mushaf = _mushaf()
        with self.assertRaises(HttpError):
            processing_service.process(
                mushaf, page_range_start=1, page_range_end=1, **_SETTINGS
            )

    def test_invalid_range_rejected(self):
        mushaf = _mushaf(pages=3)
        _add_templates(mushaf)
        with self.assertRaises(HttpError):
            processing_service.process(
                mushaf, page_range_start=1, page_range_end=99, **_SETTINGS
            )


class ProcessRunTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_creates_run(self):
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)
        result = processing_service.process(
            mushaf, page_range_start=1, page_range_end=1, **_SETTINGS
        )
        self.assertIn("run_id", result)
        self.assertEqual(ProcessingRun.objects.filter(mushaf=mushaf).count(), 1)
        self.assertIn(result["status"], {"completed", "aborted_line_detection"})

"""Tests for api.services.processing (guards + render→pipeline→persist wiring)."""

from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from ninja.errors import HttpError

from api.models import ActivityEvent, ActivityTypeChoices, Page, ProcessingRun
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
            image=SimpleUploadedFile(f"{template_type}.png", make_png_bytes((40, 40)), "image/png"),
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
            processing_service.process(mushaf, page_range_start=1, page_range_end=1, **_SETTINGS)

    def test_invalid_range_rejected(self):
        mushaf = _mushaf(pages=3)
        _add_templates(mushaf)
        with self.assertRaises(HttpError):
            processing_service.process(mushaf, page_range_start=1, page_range_end=99, **_SETTINGS)


class ProcessRunTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_creates_run(self):
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)
        result = processing_service.process(mushaf, page_range_start=1, page_range_end=1, **_SETTINGS)
        self.assertIn("run_id", result)
        self.assertEqual(ProcessingRun.objects.filter(mushaf=mushaf).count(), 1)
        self.assertIn(result["status"], {"completed", "aborted_line_detection"})
        event = ActivityEvent.objects.get(mushaf=mushaf, type=ActivityTypeChoices.RUN_FINISHED)
        self.assertEqual(event.payload["run_id"], str(result["run_id"]))
        self.assertEqual(event.payload["run_number"], 1)
        self.assertEqual(event.payload["status"], result["status"])
        self.assertEqual(event.payload["page_range_start"], 1)


class ListRunsTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()

    def test_orders_newest_first_with_stable_numbers(self):
        mushaf = _mushaf(pages=3)
        run1 = ProcessingRun.objects.create(
            mushaf=mushaf, settings={"expected_lines": 15}, page_range_start=1, page_range_end=3, status="completed"
        )
        # Force run1 clearly older so created_at ordering is deterministic.
        ProcessingRun.objects.filter(id=run1.id).update(created_at=timezone.now() - timedelta(days=1))
        run2 = ProcessingRun.objects.create(
            mushaf=mushaf,
            settings={"expected_lines": 15, "match_threshold": 0.35},
            page_range_start=1,
            page_range_end=50,
            status="aborted_line_detection",
            abort_info='{"page": 25, "expected": 15, "detected": 14}',
        )
        Page.objects.create(mushaf=mushaf, page_number=1, last_run=run2)
        Page.objects.create(mushaf=mushaf, page_number=2, last_run=run2)

        runs = processing_service.list_runs(mushaf)

        self.assertEqual([r["run_number"] for r in runs], [2, 1])  # newest first, numbers stable
        self.assertEqual(runs[0]["id"], run2.id)
        self.assertEqual(runs[0]["pages_saved"], 2)
        self.assertEqual(runs[0]["abort_info"], {"page": 25, "expected": 15, "detected": 14})
        self.assertIsNone(runs[1]["abort_info"])
        self.assertEqual(runs[1]["pages_saved"], 0)

    def test_empty_when_no_runs(self):
        self.assertEqual(processing_service.list_runs(_mushaf(pages=1)), [])

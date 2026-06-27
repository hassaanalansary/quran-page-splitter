"""Tests for export.export_lines (transparent line PNGs)."""

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import ProcessingRun
from api.services import coordinates, export, suras
from api.services import mushaf as mushaf_service
from api.tests.helpers import MediaTestCase, make_pdf_bytes


class ExportLinesTests(MediaTestCase):
    def setUp(self):
        suras.seed_reference_data()
        created = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(2), "application/pdf"),
            name="Export",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
        )
        self.mushaf = mushaf_service.get_mushaf(created["mushaf"]["id"])
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        self.page = coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "sura_header",
                        "sura_number": 1,
                        "line_bbox": {"x": 100, "y": 100, "w": 200, "h": 50},
                    }
                ],
            },
        )

    def test_exports_png_and_sets_path(self):
        result = export.export_lines(mushaf_id=self.mushaf.id, page_number=1)
        self.assertEqual(result["exported"], 1)
        line = self.page.lines.get(line_number=1)
        self.assertTrue(line.line_png)
        self.assertTrue(line.line_png.name.endswith(".png"))

    def test_export_applies_erase_stroke(self):
        self.page.lines.get(line_number=1).erase_strokes.create(brush_size=10, points=[[120, 120], [140, 140]])
        result = export.export_lines(mushaf_id=self.mushaf.id, page_number=1)
        self.assertEqual(result["exported"], 1)

    def test_missing_page_rejected(self):
        with self.assertRaises(HttpError):
            export.export_lines(mushaf_id=self.mushaf.id, page_number=5)

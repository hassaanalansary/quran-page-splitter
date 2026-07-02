"""Tests for export.export_lines (transparent line PNGs) + the coordinates document."""

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from ninja.errors import HttpError

from api.models import ActivityEvent, ActivityTypeChoices, ProcessingRun
from api.services import coordinates, export, suras
from api.services import mushaf as mushaf_service
from api.tests.helpers import MediaTestCase, bare_mushaf, make_pdf_bytes


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
        event = ActivityEvent.objects.get(mushaf=self.mushaf, type=ActivityTypeChoices.LINES_EXPORTED)
        self.assertEqual(event.payload, {"page_number": 1, "exported": 1})

    def test_export_applies_erase_stroke(self):
        self.page.lines.get(line_number=1).erase_strokes.create(brush_size=10, points=[[120, 120], [140, 140]])
        result = export.export_lines(mushaf_id=self.mushaf.id, page_number=1)
        self.assertEqual(result["exported"], 1)

    def test_missing_page_rejected(self):
        with self.assertRaises(HttpError):
            export.export_lines(mushaf_id=self.mushaf.id, page_number=5)


class CoordinatesJsonTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Coord Doc")
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "text",
                        "line_bbox": {"x": 5, "y": 10, "w": 200, "h": 30},
                        "segments": [
                            {"bbox": {"x": 100, "w": 100}, "has_separator": True, "aya_number": 1, "sura_number": 1},
                            {"bbox": {"x": 5, "w": 90}, "has_separator": False, "aya_number": 2, "sura_number": 1},
                        ],
                    },
                    {
                        "line_number": 2,
                        "type": "text",
                        "line_bbox": {"x": 5, "y": 45, "w": 200, "h": 30},
                        "segments": [
                            {"bbox": {"x": 5, "w": 195}, "has_separator": True, "aya_number": 2, "sura_number": 1},
                        ],
                    },
                ],
            },
        )

    def test_document_shape_and_aya_grouping(self):
        filename, doc = export.coordinates_json(self.mushaf.id)
        self.assertEqual(filename, "Coord-Doc-coordinates.json")  # space sanitized
        self.assertEqual(doc["schema"], "aya-bbox/v1")
        self.assertEqual(doc["mushaf"]["name"], "Coord Doc")

        [page] = doc["pages"]
        self.assertEqual(page["page"], 1)
        self.assertEqual([a["aya"] for a in page["ayas"]], [1, 2])  # reading order
        by_key = {(a["sura"], a["aya"]): a for a in page["ayas"]}
        # aya 1: one segment; x/w from the segment, y/h from its line
        self.assertEqual(by_key[(1, 1)]["rects"], [{"x": 100, "y": 10, "w": 100, "h": 30}])
        # aya 2 spans lines 1 and 2 → both rects grouped under one entry
        self.assertEqual(len(by_key[(1, 2)]["rects"]), 2)
        self.assertEqual(by_key[(1, 2)]["rects"][1], {"x": 5, "y": 45, "w": 195, "h": 30})

    def test_pages_without_ayas_are_omitted(self):
        empty = bare_mushaf("Coord Empty")
        _, doc = export.coordinates_json(empty.id)
        self.assertEqual(doc["pages"], [])

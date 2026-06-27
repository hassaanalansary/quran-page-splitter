"""Tests for editing.get_page_data and editing.save_page."""

from django.test import TestCase
from ninja.errors import HttpError

from api.models import ProcessingRun
from api.services import coordinates, editing, suras
from api.tests.helpers import bare_mushaf


def _save_payload() -> dict:
    return {
        "bbox": {"x": 0, "y": 0, "w": 500, "h": 700},
        "lines": [
            {
                "line_number": 1,
                "type": "sura_header",
                "sura_number": 1,
                "bbox_x": 1,
                "bbox_y": 1,
                "bbox_w": 10,
                "bbox_h": 10,
                "segments": [],
            },
            {
                "line_number": 2,
                "type": "text",
                "bbox_x": 1,
                "bbox_y": 20,
                "bbox_w": 100,
                "bbox_h": 20,
                "segments": [
                    {"segment_order": 1, "bbox_x": 50, "bbox_w": 50, "has_separator": True, "aya_number": 999},
                    {"segment_order": 2, "bbox_x": 1, "bbox_w": 49, "has_separator": False, "aya_number": 999},
                ],
            },
        ],
    }


class GetPageDataTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Pages")

    def test_empty_for_unprocessed_page(self):
        self.assertEqual(
            editing.get_page_data(self.mushaf.id, 3),
            {"page_number": 3, "bbox": None, "lines": []},
        )

    def test_out_of_range(self):
        with self.assertRaises(HttpError):
            editing.get_page_data(self.mushaf.id, 999)

    def test_returns_processed_page(self):
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
                "crop_box": {"x": 0, "y": 0, "w": 10, "h": 10},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "sura_header",
                        "sura_number": 1,
                        "line_bbox": {"x": 0, "y": 0, "w": 5, "h": 5},
                    }
                ],
            },
        )
        data = editing.get_page_data(self.mushaf.id, 1)
        self.assertEqual(data["page_number"], 1)
        self.assertEqual(len(data["lines"]), 1)
        self.assertEqual(data["lines"][0]["type"], "sura_header")


class SavePageTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("SavePages")

    def test_save_replaces_and_renumbers(self):
        payload = _save_payload()
        result = editing.save_page(
            mushaf_id=self.mushaf.id,
            page_number=1,
            bbox=payload["bbox"],
            lines=payload["lines"],
        )
        self.assertEqual(len(result["lines"]), 2)
        text = next(line for line in result["lines"] if line["type"] == "text")
        # aya numbers are derived (the payload's 999s are ignored): ayas 1, 2.
        self.assertEqual([s["aya_number"] for s in text["segments"]], [1, 2])

    def test_invalid_line_type(self):
        payload = _save_payload()
        payload["lines"][0]["type"] = "bogus"
        with self.assertRaises(HttpError):
            editing.save_page(
                mushaf_id=self.mushaf.id,
                page_number=1,
                bbox=payload["bbox"],
                lines=payload["lines"],
            )

"""Tests for api.services.coordinates (engine coordinate dict -> DB rows)."""

from django.test import TestCase

from api.models import Line, Mushaf, ProcessingRun, Segment
from api.services import coordinates, suras


def _coord_page() -> dict:
    return {
        "page_number": 1,
        "crop_box": {"x": 10, "y": 20, "w": 800, "h": 1000},
        "lines": [
            {
                "line_number": 1,
                "type": "sura_header",
                "sura_number": 2,
                "line_bbox": {"x": 1, "y": 2, "w": 3, "h": 4},
            },
            {
                "line_number": 2,
                "type": "basmala",
                "sura_number": 2,
                "line_bbox": {"x": 1, "y": 6, "w": 3, "h": 4},
            },
            {
                "line_number": 3,
                "type": "text",
                "line_bbox": {"x": 1, "y": 10, "w": 300, "h": 40},
                "separator_cuts": [150],
                "segments": [
                    {
                        "sura_number": 2,
                        "aya_number": 1,
                        "has_separator": True,
                        "is_continuation": False,
                        "bbox": {"x": 150, "y": 10, "w": 151, "h": 40},
                    },
                    {
                        "sura_number": 2,
                        "aya_number": 2,
                        "has_separator": False,
                        "is_continuation": True,
                        "bbox": {"x": 1, "y": 10, "w": 149, "h": 40},
                    },
                ],
            },
        ],
    }


class WriteCoordsToPageTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = Mushaf.objects.create(
            name="Coords",
            pdf_sha256="x",
            pdf_page_count=10,
            first_quran_pdf_page=1,
            last_quran_pdf_page=10,
        )
        self.run = ProcessingRun.objects.create(
            mushaf=self.mushaf, page_range_start=1, page_range_end=1, status="completed"
        )

    def _write(self, coord_page):
        return coordinates.write_coords_to_page(mushaf=self.mushaf, page_number=1, run=self.run, coord_page=coord_page)

    def test_creates_page_with_crop_bbox(self):
        page = self._write(_coord_page())
        self.assertEqual((page.bbox_x, page.bbox_y, page.bbox_w, page.bbox_h), (10, 20, 800, 1000))
        self.assertEqual(page.last_run_id, self.run.id)
        self.assertEqual(page.lines.count(), 3)

    def test_translates_basmala_to_besmella(self):
        page = self._write(_coord_page())
        types = list(page.lines.order_by("line_number").values_list("type", flat=True))
        self.assertEqual(types, ["sura_header", "besmella", "text"])

    def test_sets_sura_on_all_lines(self):
        page = self._write(_coord_page())
        self.assertEqual(set(page.lines.values_list("sura_id", flat=True)), {2})

    def test_segments_persisted_in_order(self):
        page = self._write(_coord_page())
        segments = list(page.lines.get(line_number=3).segments.order_by("segment_order"))
        self.assertEqual([s.aya_number for s in segments], [1, 2])
        self.assertEqual([s.has_separator for s in segments], [True, False])
        self.assertEqual((segments[0].bbox_x, segments[0].bbox_w), (150, 151))

    def test_reprocess_replaces_rows(self):
        self._write(_coord_page())
        page = self._write(
            {
                "crop_box": {"x": 0, "y": 0, "w": 100, "h": 100},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "sura_header",
                        "sura_number": 1,
                        "line_bbox": {"x": 1, "y": 1, "w": 1, "h": 1},
                    }
                ],
            }
        )
        self.assertEqual(page.lines.count(), 1)
        self.assertEqual(Line.objects.filter(page=page).count(), 1)
        self.assertEqual(Segment.objects.filter(line__page=page).count(), 0)

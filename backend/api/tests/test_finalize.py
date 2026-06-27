"""Tests for editing.save_finalize (cut layer: bbox overrides + erase strokes)."""

from django.test import TestCase
from ninja.errors import HttpError

from api.models import EraseStroke, ProcessingRun
from api.services import coordinates, editing, suras
from api.tests.helpers import bare_mushaf


class SaveFinalizeTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Finalize")
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
                "crop_box": {"x": 0, "y": 0, "w": 100, "h": 100},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "sura_header",
                        "sura_number": 1,
                        "line_bbox": {"x": 10, "y": 10, "w": 80, "h": 30},
                    }
                ],
            },
        )

    def test_bbox_override_and_strokes(self):
        editing.save_finalize(
            mushaf_id=self.mushaf.id,
            page_number=1,
            line_edits=[
                {
                    "line_number": 1,
                    "bbox_override": {"x": 5, "y": 6, "w": 70, "h": 25},
                    "erase_strokes": [{"brush_size": 8, "points": [[1, 2], [3, 4]]}],
                }
            ],
        )
        line = self.page.lines.get(line_number=1)
        self.assertEqual((line.bbox_x, line.bbox_y, line.bbox_w, line.bbox_h), (5, 6, 70, 25))
        self.assertEqual(line.erase_strokes.count(), 1)
        stroke = line.erase_strokes.first()
        self.assertEqual(stroke.brush_size, 8)
        self.assertEqual(stroke.points, [[1, 2], [3, 4]])

    def test_strokes_replaced_on_resave(self):
        edits = [{"line_number": 1, "erase_strokes": [{"brush_size": 8, "points": [[1, 2]]}]}]
        editing.save_finalize(mushaf_id=self.mushaf.id, page_number=1, line_edits=edits)
        editing.save_finalize(mushaf_id=self.mushaf.id, page_number=1, line_edits=edits)
        self.assertEqual(EraseStroke.objects.filter(line__page=self.page).count(), 1)

    def test_missing_page_rejected(self):
        with self.assertRaises(HttpError):
            editing.save_finalize(mushaf_id=self.mushaf.id, page_number=5, line_edits=[])

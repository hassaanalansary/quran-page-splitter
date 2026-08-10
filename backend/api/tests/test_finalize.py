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

    def test_bbox_override_updates_yh_only(self):
        """Finalize adjusts only the line's Y/H; X/W (content extent from segments,
        used by the coordinates export) are preserved — the cut width is derived
        from the page bounds at export time, not stored on the line."""
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
        # x=10 / w=80 from setup are untouched; only y/h come from the override.
        self.assertEqual((line.bbox_x, line.bbox_y, line.bbox_w, line.bbox_h), (10, 6, 80, 25))
        self.assertEqual(line.erase_strokes.count(), 1)
        stroke = line.erase_strokes.first()
        self.assertEqual(stroke.brush_size, 8)
        self.assertEqual(stroke.points, [[1, 2], [3, 4]])

    def test_strokes_replaced_on_resave(self):
        edits = [{"line_number": 1, "erase_strokes": [{"brush_size": 8, "points": [[1, 2]]}]}]
        editing.save_finalize(mushaf_id=self.mushaf.id, page_number=1, line_edits=edits)
        editing.save_finalize(mushaf_id=self.mushaf.id, page_number=1, line_edits=edits)
        self.assertEqual(EraseStroke.objects.filter(line__page=self.page).count(), 1)

    def test_page_dict_round_trips_strokes(self):
        """Saved erase strokes come back in the page's editor dict (Finalize revisit)."""
        editing.save_finalize(
            mushaf_id=self.mushaf.id,
            page_number=1,
            line_edits=[
                {"line_number": 1, "erase_strokes": [{"brush_size": 8, "points": [[1, 2], [3, 4]]}]}
            ],
        )
        line = coordinates.page_to_dict(self.page)["lines"][0]
        self.assertEqual(line["erase_strokes"], [{"brush_size": 8, "points": [[1, 2], [3, 4]]}])

    def test_missing_page_rejected(self):
        with self.assertRaises(HttpError):
            editing.save_finalize(mushaf_id=self.mushaf.id, page_number=5, line_edits=[])


class PageColumnTests(TestCase):
    """coordinates.page_column: a real crop is kept; a manual page's 1x1
    placeholder is replaced by the union (bounding box) of its line boxes."""

    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Column")

    def _page(self, crop: dict, lines: list[dict]):
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 1, "start_aya": 1},
            page_range_start=1,
            page_range_end=1,
            status="completed",
        )
        return coordinates.write_coords_to_page(
            mushaf=self.mushaf, page_number=1, run=run, coord_page={"crop_box": crop, "lines": lines}
        )

    def test_real_crop_box_used_as_is(self):
        page = self._page(
            {"x": 5, "y": 6, "w": 400, "h": 700},
            [{"line_number": 1, "type": "text", "line_bbox": {"x": 10, "y": 10, "w": 100, "h": 30}}],
        )
        self.assertEqual(coordinates.page_column(page), {"x": 5, "y": 6, "w": 400, "h": 700})

    def test_placeholder_crop_derives_union_of_lines(self):
        page = self._page(
            {"x": 0, "y": 0, "w": 1, "h": 1},  # manual-page placeholder
            [
                {"line_number": 1, "type": "text", "line_bbox": {"x": 50, "y": 10, "w": 200, "h": 30}},
                {"line_number": 2, "type": "text", "line_bbox": {"x": 20, "y": 50, "w": 100, "h": 30}},
            ],
        )
        # union: x=min(50,20)=20, right=max(250,120)=250 → w=230; y=10, bottom=80 → h=70
        self.assertEqual(coordinates.page_column(page), {"x": 20, "y": 10, "w": 230, "h": 70})

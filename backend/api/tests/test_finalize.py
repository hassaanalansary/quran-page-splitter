"""Tests for editing.save_finalize (cut layer: bbox overrides + erase strokes) and the
Finalize tracker (editing.mark_lines_finalized)."""

from django.test import TestCase
from ninja.errors import HttpError

from api.models import EraseStroke, ProcessingRun
from api.services import coordinates, editing
from api.services import mushaf as mushaf_service
from api.tests.helpers import bare_mushaf, default_user
from quran.services import suras


class OneProcessedPageCase(TestCase):
    """A mushaf with page 1 processed: one line, a sura header."""

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


class SaveFinalizeTests(OneProcessedPageCase):
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
            user=default_user(),
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
        editing.save_finalize(mushaf_id=self.mushaf.id, page_number=1, line_edits=edits, user=default_user())
        editing.save_finalize(mushaf_id=self.mushaf.id, page_number=1, line_edits=edits, user=default_user())
        self.assertEqual(EraseStroke.objects.filter(line__page=self.page).count(), 1)

    def test_page_dict_round_trips_strokes(self):
        """Saved erase strokes come back in the page's editor dict (Finalize revisit)."""
        editing.save_finalize(
            mushaf_id=self.mushaf.id,
            page_number=1,
            line_edits=[{"line_number": 1, "erase_strokes": [{"brush_size": 8, "points": [[1, 2], [3, 4]]}]}],
            user=default_user(),
        )
        line = coordinates.page_to_dict(self.page)["lines"][0]
        self.assertEqual(line["erase_strokes"], [{"brush_size": 8, "points": [[1, 2], [3, 4]]}])

    def test_edge_ink_switch_is_saved_and_left_alone_when_an_edit_does_not_say(self):
        def save(edit: dict) -> bool:
            editing.save_finalize(
                mushaf_id=self.mushaf.id, page_number=1, line_edits=[{"line_number": 1, **edit}], user=default_user()
            )
            return coordinates.page_to_dict(self.page)["lines"][0]["erase_edge_ink"]

        self.assertIs(save({"erase_edge_ink": True}), True)
        self.assertIs(save({"erase_edge_ink": None}), True)
        self.assertIs(save({}), True)
        self.assertIs(save({"erase_edge_ink": False}), False)


class LinesFinalizedTests(OneProcessedPageCase):
    """The Finalize tracker: set only by a person, cleared when the lines are rebuilt."""

    def mark(self, finalized: bool = True) -> dict:
        return editing.mark_lines_finalized(
            user=default_user(), mushaf_id=self.mushaf.id, page_number=1, finalized=finalized
        )

    def finalized(self) -> bool:
        self.page.refresh_from_db()
        return self.page.lines_finalized

    def line_payload(self) -> dict:
        return {
            "line_number": 1,
            "type": "sura_header",
            "sura_number": 1,
            "bbox_x": 10,
            "bbox_y": 10,
            "bbox_w": 80,
            "bbox_h": 30,
            "segments": [],
        }

    def test_marking_and_unmarking_show_in_the_page_and_the_page_list(self):
        self.assertEqual(self.mark(), {"page_number": 1, "lines_finalized": True})
        self.page.refresh_from_db()
        self.assertIs(coordinates.page_to_dict(self.page)["lines_finalized"], True)
        summary = editing.list_pages(self.mushaf.id, user=default_user())[0]
        self.assertIs(summary["lines_finalized"], True)
        self.mark(False)
        self.assertFalse(self.finalized())

    def test_saving_cuts_does_not_mark_the_page(self):
        editing.save_finalize(
            mushaf_id=self.mushaf.id, page_number=1, line_edits=[{"line_number": 1}], user=default_user()
        )
        self.assertFalse(self.finalized())

    def test_reprocessing_clears_it(self):
        self.mark()
        coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=self.page.last_run,
            coord_page={"crop_box": {"x": 0, "y": 0, "w": 100, "h": 100}, "lines": []},
        )
        self.assertFalse(self.finalized())

    def test_a_review_save_clears_it(self):
        self.mark()
        editing.save_page(
            user=default_user(),
            mushaf_id=self.mushaf.id,
            page_number=1,
            bbox={"x": 0, "y": 0, "w": 100, "h": 100},
            lines=[self.line_payload()],
        )
        self.assertFalse(self.finalized())

    def test_a_bulk_review_save_clears_it_on_the_pages_it_writes(self):
        self.mark()
        editing.bulk_save(
            user=default_user(),
            mushaf_id=self.mushaf.id,
            pages=[{"page_number": 1, "bbox": {"x": 0, "y": 0, "w": 100, "h": 100}, "lines": [self.line_payload()]}],
            reviewed_pages=[1],
        )
        self.assertFalse(self.finalized())

    def test_a_bulk_review_save_leaves_the_pages_it_only_flags(self):
        self.mark()
        editing.bulk_save(user=default_user(), mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[1])
        self.assertTrue(self.finalized())

    def test_a_missing_page_is_refused(self):
        with self.assertRaises(HttpError):
            editing.mark_lines_finalized(user=default_user(), mushaf_id=self.mushaf.id, page_number=2, finalized=True)


class LinePaddingTests(OneProcessedPageCase):
    """The padding a page's lines carry, saved with them, and the mushaf's usual one."""

    def save(self, page_number: int = 1, **page_fields) -> dict:
        return editing.save_finalize(
            user=default_user(), mushaf_id=self.mushaf.id, page_number=page_number, line_edits=[], **page_fields
        )

    def add_page(self, page_number: int) -> None:
        coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=page_number,
            run=self.page.last_run,
            coord_page={"crop_box": {"x": 0, "y": 0, "w": 100, "h": 100}, "lines": []},
        )

    def usual(self) -> int | None:
        return mushaf_service.find_usual_line_padding(self.mushaf)

    def test_the_padding_and_the_check_are_saved_with_the_cuts_and_left_alone_when_not_given(self):
        page = self.save(line_padding=14, lines_finalized=True)
        self.assertEqual((page["line_padding"], page["lines_finalized"]), (14, True))
        page = self.save()
        self.assertEqual((page["line_padding"], page["lines_finalized"]), (14, True))

    def test_rebuilding_the_lines_forgets_the_padding(self):
        self.save(line_padding=14)
        self.add_page(1)  # reprocessing page 1
        self.page.refresh_from_db()
        self.assertIsNone(self.page.line_padding)

    def test_three_checked_pages_agreeing_make_the_usual_padding(self):
        for number in (2, 3):
            self.add_page(number)
        self.save(1, line_padding=14, lines_finalized=True)
        self.save(2, line_padding=14, lines_finalized=True)
        self.assertIsNone(self.usual())  # two are not yet a habit
        self.save(3, line_padding=14, lines_finalized=True)
        self.assertEqual(self.usual(), 14)

    def test_the_latest_three_must_agree_and_unchecked_pages_do_not_count(self):
        for number in (2, 3, 4, 5):
            self.add_page(number)
        for number in (1, 2, 3):
            self.save(number, line_padding=14, lines_finalized=True)
        self.save(4, line_padding=20)  # saved, never checked
        self.assertEqual(self.usual(), 14)
        self.save(5, line_padding=12, lines_finalized=True)
        self.assertIsNone(self.usual())

    def test_missing_page_rejected(self):
        with self.assertRaises(HttpError):
            editing.save_finalize(mushaf_id=self.mushaf.id, page_number=5, line_edits=[], user=default_user())


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

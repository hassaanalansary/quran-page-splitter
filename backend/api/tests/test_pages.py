"""Tests for editing.get_page_data and editing.save_page."""

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from ninja.errors import HttpError

from api.models import ActivityEvent, ActivityTypeChoices, Page, ProcessingRun
from api.services import coordinates, editing, suras
from api.tests.helpers import bare_mushaf, default_user


def _seed_pages(mushaf, count: int, settings: dict | None = None) -> ProcessingRun:
    """Create `count` processed pages (each one text line, two ayas) under one run."""
    run = ProcessingRun.objects.create(
        mushaf=mushaf,
        settings=settings or {"start_sura": 1, "start_aya": 1},
        page_range_start=1,
        page_range_end=count,
        status="completed",
    )
    for n in range(1, count + 1):
        coordinates.write_coords_to_page(
            mushaf=mushaf,
            page_number=n,
            run=run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 400, "h": 400},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "text",
                        "line_bbox": {"x": 0, "y": 0, "w": 200, "h": 30},
                        "segments": [
                            {"bbox": {"x": 100, "w": 100}, "has_separator": True, "aya_number": 1, "sura_number": 1},
                            {"bbox": {"x": 0, "w": 100}, "has_separator": True, "aya_number": 2, "sura_number": 1},
                        ],
                    }
                ],
            },
        )
    return run


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
            editing.get_page_data(self.mushaf.id, 3, user=default_user()),
            {"page_number": 3, "bbox": None, "lines": []},
        )

    def test_out_of_range(self):
        with self.assertRaises(HttpError):
            editing.get_page_data(self.mushaf.id, 999, user=default_user())

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
        data = editing.get_page_data(self.mushaf.id, 1, user=default_user())
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
            mushaf_id=self.mushaf.id, page_number=1, bbox=payload["bbox"], lines=payload["lines"], user=default_user()
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
                user=default_user(),
            )


class ListPagesTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("ListPages")

    def test_empty_when_none_processed(self):
        self.assertEqual(editing.list_pages(self.mushaf.id, user=default_user()), [])

    def test_lists_saved_pages_with_summary(self):
        payload = _save_payload()
        editing.save_page(
            mushaf_id=self.mushaf.id, page_number=2, bbox=payload["bbox"], lines=payload["lines"], user=default_user()
        )
        [row] = editing.list_pages(self.mushaf.id, user=default_user())
        self.assertEqual(row["page_number"], 2)
        self.assertTrue(row["reviewed"])  # save_page marks the page reviewed
        self.assertEqual(row["source_pdf_page"], 2)  # first_quran_pdf_page=1 → 1 + 2 - 1
        self.assertEqual(row["lines"], 2)
        self.assertEqual(row["segments"], 2)
        self.assertEqual(row["ayat"], 1)  # only the has_separator segment closes an aya
        self.assertTrue(row["has_header"])
        self.assertEqual(row["suras"][0]["number"], 1)
        self.assertEqual(row["suras"][0]["transliteration"], "Al-Fatiha")


class ReviewDataTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Rev")

    def test_empty(self):
        self.assertEqual(
            editing.review_data(self.mushaf.id, user=default_user()), {"start": {"sura": 1, "aya": 1}, "pages": []}
        )

    def test_seed_from_run_and_ordered(self):
        _seed_pages(self.mushaf, 2, {"start_sura": 2, "start_aya": 5})
        data = editing.review_data(self.mushaf.id, user=default_user())
        self.assertEqual(data["start"], {"sura": 2, "aya": 5})  # entry state of page 1 = run seed
        self.assertEqual([p["page_number"] for p in data["pages"]], [1, 2])

    def test_pages_carry_reviewed_flag(self):
        _seed_pages(self.mushaf, 1)
        self.assertFalse(editing.review_data(self.mushaf.id, user=default_user())["pages"][0]["reviewed"])
        Page.objects.filter(mushaf=self.mushaf, page_number=1).update(reviewed=True)
        self.assertTrue(editing.review_data(self.mushaf.id, user=default_user())["pages"][0]["reviewed"])

    def test_pages_carry_run_start(self):
        _seed_pages(self.mushaf, 2, {"start_sura": 2, "start_aya": 5})
        pages = editing.review_data(self.mushaf.id, user=default_user())["pages"]
        # Each processed page reports the (sura, aya) its run began at — the island
        # seed used when the page follows a gap.
        self.assertEqual(pages[0]["run_start"], {"sura": 2, "aya": 5})
        self.assertEqual(pages[1]["run_start"], {"sura": 2, "aya": 5})

    def test_seed_defaults_to_one_when_page_one_missing(self):
        run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 2, "start_aya": 1},
            page_range_start=3,
            page_range_end=3,
            status="completed",
        )
        coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=3,
            run=run,
            coord_page={"crop_box": {"x": 0, "y": 0, "w": 10, "h": 10}, "lines": []},
        )
        # First processed page is 3, but the client numbers from page 1 → seed (1,1).
        self.assertEqual(editing.review_data(self.mushaf.id, user=default_user())["start"], {"sura": 1, "aya": 1})

    def test_review_data_query_count_is_constant(self):
        """Review-data holds a fixed query count regardless of page count (no N+1)."""
        small = bare_mushaf("Rev-q-small", last_quran_pdf_page=2)
        _seed_pages(small, 2)
        big = bare_mushaf("Rev-q-big", last_quran_pdf_page=8)
        _seed_pages(big, 8)
        with CaptureQueriesContext(connection) as small_q:
            editing.review_data(small.id, user=default_user())
        with CaptureQueriesContext(connection) as big_q:
            editing.review_data(big.id, user=default_user())
        self.assertEqual(len(big_q.captured_queries), len(small_q.captured_queries))
        self.assertLessEqual(len(big_q.captured_queries), 6)


class BulkSaveTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Bulk")
        _seed_pages(self.mushaf, 3)

    def _page(self, n: int) -> Page:
        return Page.objects.get(mushaf=self.mushaf, page_number=n)

    def _one_line_payload(self, page_number: int) -> dict:
        return {
            "page_number": page_number,
            "bbox": {"x": 0, "y": 0, "w": 10, "h": 10},
            "lines": [
                {
                    "line_number": 1,
                    "type": "text",
                    "bbox_x": 0,
                    "bbox_y": 0,
                    "bbox_w": 10,
                    "bbox_h": 10,
                    "segments": [
                        {"segment_order": 1, "bbox_x": 0, "bbox_w": 10, "has_separator": True, "aya_number": 1}
                    ],
                }
            ],
        }

    def test_writes_lines_without_flipping_reviewed(self):
        editing.bulk_save(
            mushaf_id=self.mushaf.id, pages=[self._one_line_payload(1)], reviewed_pages=[], user=default_user()
        )
        self.assertFalse(self._page(1).reviewed)  # data write must NOT mark reviewed
        self.assertEqual(self._page(1).lines.count(), 1)  # replaced the 1 seeded line

    def test_reviewed_flags_only_listed_pages(self):
        editing.bulk_save(mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[1, 3], user=default_user())
        self.assertTrue(self._page(1).reviewed)
        self.assertFalse(self._page(2).reviewed)
        self.assertTrue(self._page(3).reviewed)

    def test_single_review_event(self):
        editing.bulk_save(mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[2], user=default_user())
        event = ActivityEvent.objects.get(mushaf=self.mushaf, type=ActivityTypeChoices.REVIEW_SAVED)
        self.assertEqual(event.payload, {"page_number": 2})

    def test_range_review_event(self):
        editing.bulk_save(mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[3, 1, 2], user=default_user())
        event = ActivityEvent.objects.get(mushaf=self.mushaf, type=ActivityTypeChoices.REVIEW_SAVED)
        self.assertEqual(event.payload, {"page_start": 1, "page_end": 3, "count": 3})

    def test_no_event_when_already_reviewed(self):
        editing.bulk_save(mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[1], user=default_user())
        editing.bulk_save(mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[1], user=default_user())
        self.assertEqual(
            ActivityEvent.objects.filter(mushaf=self.mushaf, type=ActivityTypeChoices.REVIEW_SAVED).count(), 1
        )

    def test_returns_review_data(self):
        out = editing.bulk_save(mushaf_id=self.mushaf.id, pages=[], reviewed_pages=[], user=default_user())
        self.assertEqual(out["start"], {"sura": 1, "aya": 1})
        self.assertEqual(len(out["pages"]), 3)

    def test_creates_manual_page(self):
        # Page 5 has no row (only 1..3 are seeded) — manual processing must create it.
        editing.bulk_save(
            mushaf_id=self.mushaf.id, pages=[self._one_line_payload(5)], reviewed_pages=[5], user=default_user()
        )
        self.assertTrue(Page.objects.filter(mushaf=self.mushaf, page_number=5).exists())
        self.assertEqual(self._page(5).lines.count(), 1)
        self.assertTrue(self._page(5).reviewed)

"""Tests for coordinates.renumber_from (forward sura/aya recompute)."""

from django.test import TestCase

from api.models import ProcessingRun
from api.services import coordinates
from api.tests.helpers import bare_mushaf
from quran.services import suras


def _two_sep_text_page(sura: int, aya1: int, aya2: int) -> dict:
    """A page with one text line of two separator-terminated segments."""
    return {
        "crop_box": {"x": 0, "y": 0, "w": 100, "h": 100},
        "lines": [
            {
                "line_number": 1,
                "type": "text",
                "line_bbox": {"x": 0, "y": 0, "w": 100, "h": 40},
                "separator_cuts": [50],
                "segments": [
                    {
                        "sura_number": sura,
                        "aya_number": aya1,
                        "has_separator": True,
                        "is_continuation": False,
                        "bbox": {"x": 50, "y": 0, "w": 50, "h": 40},
                    },
                    {
                        "sura_number": sura,
                        "aya_number": aya2,
                        "has_separator": True,
                        "is_continuation": False,
                        "bbox": {"x": 0, "y": 0, "w": 50, "h": 40},
                    },
                ],
            }
        ],
    }


class RenumberFromTests(TestCase):
    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Renumber", last_quran_pdf_page=5)
        self.run = ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": 2, "start_aya": 1},
            page_range_start=1,
            page_range_end=2,
            status="completed",
        )
        # Two consecutive pages seeded with deliberately-wrong aya numbers (99).
        self.page1 = coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=1,
            run=self.run,
            coord_page=_two_sep_text_page(2, 99, 99),
        )
        self.page2 = coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=2,
            run=self.run,
            coord_page=_two_sep_text_page(2, 99, 99),
        )

    def _ayas(self, page):
        return list(
            page.lines.get(line_number=1).segments.order_by("segment_order").values_list("aya_number", flat=True)
        )

    def test_seeds_from_run_start_and_propagates_forward(self):
        coordinates.renumber_from(self.page1)
        self.assertEqual(self._ayas(self.page1), [1, 2])  # seed (sura 2, aya 1)
        self.assertEqual(self._ayas(self.page2), [3, 4])  # continues into page 2

    def test_sura_assigned_on_lines(self):
        coordinates.renumber_from(self.page1)
        self.assertEqual(self.page1.lines.get(line_number=1).sura_id, 2)
        self.assertEqual(self.page2.lines.get(line_number=1).sura_id, 2)

    def test_header_advances_sura_and_resets_aya(self):
        # Page 1 ends mid-sura 2; a header opening page 2 must advance to sura 3.
        coordinates.write_coords_to_page(
            mushaf=self.mushaf,
            page_number=2,
            run=self.run,
            coord_page={
                "crop_box": {"x": 0, "y": 0, "w": 100, "h": 100},
                "lines": [
                    {
                        "line_number": 1,
                        "type": "sura_header",
                        "sura_number": 99,
                        "line_bbox": {"x": 0, "y": 0, "w": 100, "h": 40},
                    },
                    {
                        "line_number": 2,
                        "type": "text",
                        "line_bbox": {"x": 0, "y": 40, "w": 100, "h": 40},
                        "separator_cuts": [],
                        "segments": [
                            {
                                "sura_number": 99,
                                "aya_number": 99,
                                "has_separator": True,
                                "is_continuation": False,
                                "bbox": {"x": 0, "y": 40, "w": 100, "h": 40},
                            }
                        ],
                    },
                ],
            },
        )
        coordinates.renumber_from(self.page1)
        page2 = self.mushaf.pages.get(page_number=2)
        self.assertEqual(page2.lines.get(line_number=1).sura_id, 3)
        self.assertEqual(page2.lines.get(line_number=2).segments.first().aya_number, 1)

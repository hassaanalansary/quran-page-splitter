"""Tests for the sura/aya forward recompute — one page onward, and whole-mushaf."""

from django.test import TestCase

from api.models import Page, ProcessingRun
from api.services import coordinates
from api.tests.helpers import bare_mushaf
from quran.models import Rawi
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


def _header_page(sura: int) -> dict:
    """A page holding just a sura header — the thing that advances the sura."""
    return {
        "crop_box": {"x": 0, "y": 0, "w": 100, "h": 100},
        "lines": [
            {
                "line_number": 1,
                "type": "sura_header",
                "sura_number": sura,
                "line_bbox": {"x": 0, "y": 0, "w": 100, "h": 40},
            }
        ],
    }


class RenumberMushafTests(TestCase):
    """The whole-mushaf walk: the repair for a numbering written by two writers."""

    def setUp(self):
        suras.seed_reference_data()
        self.mushaf = bare_mushaf("Whole", last_quran_pdf_page=20)
        self.rawi = Rawi.objects.get(name="Hafs")
        self.mushaf.rawi = self.rawi
        self.mushaf.save(update_fields=["rawi"])

    def _run(self, first: int, last: int, sura: int, aya: int) -> ProcessingRun:
        return ProcessingRun.objects.create(
            mushaf=self.mushaf,
            settings={"start_sura": sura, "start_aya": aya},
            page_range_start=first,
            page_range_end=last,
            status="completed",
        )

    def _write(self, page_number: int, run: ProcessingRun, coord_page: dict):
        return coordinates.write_coords_to_page(
            mushaf=self.mushaf, page_number=page_number, run=run, coord_page=coord_page
        )

    def _ayas(self, page_number: int) -> list[int | None]:
        page = Page.objects.get(mushaf=self.mushaf, page_number=page_number)
        return [s.aya_number for line in page.lines.order_by("line_number") for s in line.segments.all()]

    def test_two_runs_with_different_seeds_end_up_one_numbering(self):
        """The regression this repair exists for.

        Each run numbered only its own page range, from its own seed, so page 2
        used to restart at 50 while page 1 ended at 4 — a gap the app never showed
        because the review UI derives the numbering instead of reading it.
        """
        first = self._run(1, 1, 2, 1)
        second = self._run(2, 2, 2, 50)  # a later run over a different range
        self._write(1, first, _two_sep_text_page(2, 1, 2))
        self._write(2, second, _two_sep_text_page(2, 50, 51))

        coordinates.renumber_mushaf(self.mushaf)
        self.assertEqual(self._ayas(1), [1, 2])
        self.assertEqual(self._ayas(2), [3, 4])  # continues, rather than jumping to 50

    def test_a_page_gap_is_not_walked_across(self):
        """Pages 1 and 9 are not adjacent, so page 9 reseeds from its own run."""
        first = self._run(1, 1, 2, 1)
        far = self._run(9, 9, 2, 100)
        self._write(1, first, _two_sep_text_page(2, 1, 2))
        self._write(9, far, _two_sep_text_page(2, 100, 101))

        coordinates.renumber_mushaf(self.mushaf)
        self.assertEqual(self._ayas(1), [1, 2])
        self.assertEqual(self._ayas(9), [100, 101])

    def test_reports_a_sura_whose_separators_do_not_add_up(self):
        """Al-Kawthar has 3 ayat; give it 2 separators and the walk says so."""
        run = self._run(1, 2, 108, 1)
        self._write(1, run, _two_sep_text_page(108, 1, 2))  # only two ayat closed
        self._write(2, run, _header_page(109))  # ...then the next sura begins

        plan = coordinates.renumber_mushaf(self.mushaf)
        self.assertEqual(len(plan.problems), 1, plan.problems)
        self.assertIn("sura 108", plan.problems[0])
        self.assertIn("2 separators", plan.problems[0])
        # Reported, not refused: the numbering is still written.
        self.assertEqual(self._ayas(1), [1, 2])

    def test_a_partly_covered_sura_is_not_reported(self):
        """A run over two pages sees a slice of a sura and cannot match its count."""
        run = self._run(1, 1, 2, 1)
        self._write(1, run, _two_sep_text_page(2, 1, 2))
        plan = coordinates.renumber_mushaf(self.mushaf)
        self.assertEqual(plan.problems, [])

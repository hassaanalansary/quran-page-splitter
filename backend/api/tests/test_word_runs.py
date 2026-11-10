"""Tests for settling a span before calibration processes it (``word_runs.preflight``).

The engine is not exercised here. What needs pinning is what gets rejected before a
job is registered: a background job's failures land after the response has gone, so
a fixable mistake has to become a 4xx here or it becomes a failed run instead.

The fixture is a small processed mushaf: one page, four text lines, sura 2 ayat 5-7
laid across them, with just enough ``quran`` reference data for the word stream to
resolve. Ayat and lines are wired by hand rather than by running detection, so the
geometry is arithmetic a reader can check.
"""

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import (
    Line,
    LineTypeChoices,
    Page,
    ProcessJob,
    ProcessJobKindChoices,
    ProcessJobStateChoices,
    Segment,
)
from api.services import jobs as jobs_service
from api.services import mushaf as mushaf_service
from api.services import word_runs
from api.tests.helpers import ApiTestCase, default_user, make_pdf_bytes
from quran.models import Aya, CountingSystem, Rawi, Word
from quran.services import suras

#: Words 1..12, split into three ayat of four. Enough for a page, small enough to
#: check by eye.
AYA_STARTS = {5: 1, 6: 5, 7: 9}


class PreflightTests(ApiTestCase):
    """One page: line 1 holds aya 5, line 2 aya 6, line 3 aya 7, line 4 is empty."""

    def setUp(self):
        super().setUp()
        suras.seed_reference_data()
        self.kufi = CountingSystem.objects.get(name="Kufi")
        Word.objects.bulk_create(
            [Word(id=n, text=f"w{n}", paw_count=1, ijam_above=0, ijam_below=0) for n in range(1, 13)]
        )
        Aya.objects.bulk_create(
            [
                Aya(counting_system=self.kufi, sura_id=2, number=number, start_word_id=start)
                for number, start in AYA_STARTS.items()
            ]
        )
        created = mushaf_service.create_mushaf(
            pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(1), "application/pdf"),
            name="Words",
            qiraa=None,
            first_quran_pdf_page=1,
            last_quran_pdf_page=None,
            owner=default_user(),
        )
        self.mushaf = mushaf_service.get_mushaf(created["mushaf"]["id"], user=default_user())
        self.mushaf.rawi = Rawi.objects.get(name="Hafs")
        self.mushaf.save(update_fields=["rawi"])

        self.page = Page.objects.create(mushaf=self.mushaf, page_number=1, bbox_x=100, bbox_y=0, bbox_w=600, bbox_h=400)
        self.lines = []
        for number in (1, 2, 3, 4):
            line = Line.objects.create(
                page=self.page,
                line_number=number,
                type=LineTypeChoices.TEXT,
                sura_id=2,
                bbox_x=100,
                bbox_y=50 * number,
                bbox_w=600,
                bbox_h=40,
            )
            self.lines.append(line)
        # One aya per line for the first three; the fourth carries none.
        for line, aya in zip(self.lines[:3], (5, 6, 7), strict=True):
            Segment.objects.create(
                line=line, segment_order=1, bbox_x=100, bbox_w=600, has_separator=True, aya_number=aya
            )

    def assertRefused(self, start, end, status: int = 422) -> HttpError:
        with self.assertRaises(HttpError) as caught:
            word_runs.preflight(self.mushaf, start, end)
        self.assertEqual(caught.exception.status_code, status)
        return caught.exception

    def test_a_mushaf_with_no_riwaya_is_refused(self):
        self.mushaf.rawi = None
        self.mushaf.save(update_fields=["rawi"])
        self.assertIn("riwaya", str(self.assertRefused((2, 5), (2, 7))))

    def test_an_aya_that_is_on_no_reviewed_line_says_so(self):
        """The usual cause is a mushaf processed but never renumbered.

        Detection writes ``Segment.aya_number`` null on purpose and the renumber walk
        fills it, so this is the message that points at the real missing step.
        """
        Segment.objects.update(aya_number=None)
        self.assertIn("2:5", str(self.assertRefused((2, 5), (2, 7))))

    def test_a_backwards_span_is_refused(self):
        self.assertRefused((2, 7), (2, 5))

    def test_the_end_defaults_to_the_last_aya_of_the_sura(self):
        plan = word_runs.preflight(self.mushaf, (2, 5), None)
        self.assertEqual(plan.end, (2, 7))
        # Three, not four: line 4 carries no aya, so it is outside the span. A run is
        # bounded by where the ayat are, not by how many lines the page happens to hold.
        self.assertEqual(plan.total_lines, 3)
        self.assertEqual((plan.first_page, plan.last_page), (1, 1))

    def test_a_detection_run_in_flight_blocks_a_calibration_run(self):
        """The two must not overlap: re-processing deletes the lines a calibration
        run is reading."""
        ProcessJob.objects.create(
            mushaf=self.mushaf,
            kind=ProcessJobKindChoices.DETECTION,
            page_range_start=1,
            page_range_end=1,
            state=ProcessJobStateChoices.RUNNING,
            heartbeat_at=None,
        )
        ProcessJob.objects.update(heartbeat_at=ProcessJob.objects.first().started_at)
        plan = word_runs.preflight(self.mushaf, (2, 5), (2, 7))
        with self.assertRaises(HttpError) as caught:
            jobs_service.start_words(self.mushaf, plan, runner=lambda job: None, user=default_user(), inline=True)
        self.assertEqual(caught.exception.status_code, 409)

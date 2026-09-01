"""Tests for the word-detection API — the run, the read, and the manual fix.

The engine is not exercised here. Sura 7 pins it byte for byte and a synthetic page
would only prove that a fabricated result comes back unchanged; what needs pinning is
the layer around it — what gets rejected before a job is registered, what the read
side reports, and whether a person can actually correct a mistake.

The fixture is a small processed mushaf: one page, four text lines, sura 2 ayat 5-7
laid across them, with just enough ``quran`` reference data for the word stream to
resolve. Ayat and lines are wired by hand rather than by running detection, so the
geometry is arithmetic a reader can check.
"""

import itertools
import uuid

from django.core.files.uploadedfile import SimpleUploadedFile

from api.models import (
    Line,
    LineTypeChoices,
    LineWord,
    LineWordStatus,
    Page,
    ProcessJob,
    ProcessJobKindChoices,
    ProcessJobStateChoices,
    Segment,
)
from api.services import mushaf as mushaf_service
from api.services import word_coordinates, word_runs
from api.tests.helpers import ApiTestCase, default_user, make_pdf_bytes
from quran.models import Aya, CountingSystem, Rawi, Word
from quran.services import suras

#: Words 1..12, split into three ayat of four. Enough for a page, small enough to
#: check by eye.
AYA_STARTS = {5: 1, 6: 5, 7: 9}


def _cuts(word_ids: list[int], first_x: int, step: int) -> list[dict]:
    """Evenly spaced cuts, right to left, for a line's payload."""
    return [{"word_id": word_id, "end_x": first_x - step * i} for i, word_id in enumerate(word_ids)]


class WordsApiTestCase(ApiTestCase):
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

        self.page = Page.objects.create(
            mushaf=self.mushaf, page_number=1, bbox_x=100, bbox_y=0, bbox_w=600, bbox_h=400
        )
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

    def url(self, suffix: str = "") -> str:
        return f"/api/mushafs/{self.mushaf.id}/words{suffix}"

    def _store(self, line: Line, words: list[tuple[int | None, int]]) -> None:
        """Put cuts on a line directly, as a finished run would have left them."""
        LineWord.objects.bulk_create(
            [LineWord(line=line, word_id=word_id, end_x=end_x) for word_id, end_x in words]
        )
        LineWordStatus.objects.update_or_create(line=line, defaults={"status": "exact", "reason": ""})


class PreflightTests(WordsApiTestCase):
    """Everything that must be settled while the caller can still be told.

    A background job's failures land after the response has gone, so a fixable
    mistake has to become a 4xx here or it becomes a failed run instead.
    """

    def test_a_mushaf_with_no_riwaya_is_refused(self):
        self.mushaf.rawi = None
        self.mushaf.save(update_fields=["rawi"])
        response = self.client.post(
            self.url(), {"from_sura": 2, "from_aya": 5, "to_sura": 2, "to_aya": 7}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("riwaya", response.json()["detail"])

    def test_an_aya_that_is_on_no_reviewed_line_says_so(self):
        """The usual cause is a mushaf processed but never renumbered.

        Detection writes ``Segment.aya_number`` null on purpose and the renumber walk
        fills it, so this is the message that points at the real missing step.
        """
        Segment.objects.update(aya_number=None)
        response = self.client.post(
            self.url(), {"from_sura": 2, "from_aya": 5, "to_sura": 2, "to_aya": 7}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("2:5", response.json()["detail"])

    def test_a_backwards_span_is_refused(self):
        response = self.client.post(
            self.url(), {"from_sura": 2, "from_aya": 7, "to_sura": 2, "to_aya": 5}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 422)

    def test_the_end_defaults_to_the_last_aya_of_the_sura(self):
        plan = word_runs.preflight(self.mushaf, (2, 5), None)
        self.assertEqual(plan.end, (2, 7))
        # Three, not four: line 4 carries no aya, so it is outside the span. A run is
        # bounded by where the ayat are, not by how many lines the page happens to hold.
        self.assertEqual(plan.total_lines, 3)

    def test_a_missing_ornament_template_warns_rather_than_refuses(self):
        plan = word_runs.preflight(self.mushaf, (2, 5), (2, 7))
        self.assertTrue(any("separator template" in warning for warning in plan.warnings))

    def test_a_detection_run_in_flight_blocks_a_word_run(self):
        """The two must not overlap: re-processing deletes lines, and their words go
        with them by cascade, halfway through a word run still writing more."""
        ProcessJob.objects.create(
            mushaf=self.mushaf,
            kind=ProcessJobKindChoices.DETECTION,
            page_range_start=1,
            page_range_end=1,
            state=ProcessJobStateChoices.RUNNING,
            heartbeat_at=None,
        )
        ProcessJob.objects.update(heartbeat_at=ProcessJob.objects.first().started_at)
        response = self.client.post(
            self.url(), {"from_sura": 2, "from_aya": 5, "to_sura": 2, "to_aya": 7}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 409)


class ChunkTests(WordsApiTestCase):
    def test_a_short_span_is_one_chunk(self):
        self.assertEqual(word_runs.chunks(self.mushaf, (2, 5), (2, 7)), [((2, 5), (2, 7))])

    def test_a_low_target_splits_on_aya_boundaries(self):
        """Cuts land on ayat because that is the only address the engine can start
        from — it walks a cursor, so a chunk has to be self-contained."""
        spans = word_runs.chunks(self.mushaf, (2, 5), (2, 7), target_lines=1)
        self.assertGreater(len(spans), 1)
        self.assertEqual(spans[0][0], (2, 5))
        self.assertEqual(spans[-1][1], (2, 7))
        # Contiguous: every chunk starts where the last one left off, plus one aya.
        for earlier, later in itertools.pairwise(spans):
            self.assertEqual(later[0], (earlier[1][0], earlier[1][1] + 1))


class JobTests(WordsApiTestCase):
    def test_no_run_yet_is_a_normal_answer(self):
        response = self.client.get(self.url("/job"))
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["job"])

    def test_a_detection_run_does_not_show_up_as_a_word_run(self):
        ProcessJob.objects.create(
            mushaf=self.mushaf,
            kind=ProcessJobKindChoices.DETECTION,
            page_range_start=1,
            page_range_end=1,
            state=ProcessJobStateChoices.COMPLETED,
        )
        self.assertIsNone(self.client.get(self.url("/job")).json()["job"])

    def test_cancelling_nothing_is_a_404(self):
        self.assertEqual(self.client.post(self.url("/cancel")).status_code, 404)

    def test_a_run_records_a_job_and_an_activity_event(self):
        """Driven inline so the assertions see a settled row rather than a race."""
        plan = word_runs.preflight(self.mushaf, (2, 5), (2, 7))
        from api.services import jobs as jobs_service

        job = jobs_service.start_words(
            self.mushaf,
            plan,
            user=default_user(),
            runner=lambda j: jobs_service.settle(j.id, ProcessJobStateChoices.COMPLETED, lines_done=4),
            inline=True,
        )
        self.assertEqual(job.kind, ProcessJobKindChoices.WORDS)
        self.assertEqual((job.start_sura, job.start_aya, job.end_sura, job.end_aya), (2, 5, 2, 7))
        self.assertEqual(job.total, 3)  # the span's lines, not the page's
        job.refresh_from_db()
        self.assertEqual(job.state, ProcessJobStateChoices.COMPLETED)


class ReadTests(WordsApiTestCase):
    def setUp(self):
        super().setUp()
        self._store(self.lines[0], [(1, 640), (2, 500), (3, 360), (4, 220)])
        self._store(self.lines[1], [(5, 640), (6, 500), (7, 360), (8, 220)])

    def test_a_page_comes_back_line_by_line_right_to_left(self):
        response = self.client.get(f"/api/mushafs/{self.mushaf.id}/pages/1/words")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual([line["line_number"] for line in body["lines"]], [1, 2, 3, 4])
        self.assertEqual([w["end_x"] for w in body["lines"][0]["words"]], [640, 500, 360, 220])
        self.assertEqual([w["word_id"] for w in body["lines"][0]["words"]], [1, 2, 3, 4])

    def test_a_line_never_run_says_so_rather_than_pretending(self):
        body = self.client.get(f"/api/mushafs/{self.mushaf.id}/pages/1/words").json()
        self.assertIsNone(body["lines"][2]["status"])
        self.assertEqual(body["lines"][2]["words"], [])

    def test_coverage_answers_whether_it_is_processed_at_all(self):
        body = self.client.get(self.url("/coverage")).json()
        page = body["pages"][0]
        self.assertEqual((page["text_lines"], page["lines_with_words"], page["words"]), (4, 2, 8))
        self.assertFalse(page["complete"])
        self.assertFalse(body["complete"])

    def test_coverage_flags_the_lines_worth_reviewing(self):
        LineWordStatus.objects.filter(line=self.lines[0]).update(status="scored", reason="2 word(s) off-count")
        self.assertEqual(self.client.get(self.url("/coverage")).json()["pages"][0]["needs_review"], 1)

    def test_reprocessing_a_page_leaves_no_stale_words_behind(self):
        """No staleness flag needed: the rows go with their lines by cascade."""
        self.lines[0].delete()
        page = self.client.get(self.url("/coverage")).json()["pages"][0]
        self.assertEqual((page["text_lines"], page["lines_with_words"]), (3, 1))

    def test_an_unknown_page_is_a_404(self):
        self.assertEqual(self.client.get(f"/api/mushafs/{self.mushaf.id}/pages/99/words").status_code, 404)


class ManualFixTests(WordsApiTestCase):
    """The correction a person actually has to make.

    The engine reads a mark as a letter, spends one word too many on line 1, and
    everything after it shifts across the line break. Fixing that means moving a word
    between two lines, which is why the endpoint takes whole lines and takes them
    together.
    """

    def setUp(self):
        super().setUp()
        # As the engine left it: line 1 took five words when it should have taken four.
        self._store(self.lines[0], [(1, 640), (2, 520), (3, 400), (4, 280), (5, 160)])
        self._store(self.lines[1], [(6, 640), (7, 480), (8, 320)])

    def _put(self, payload: dict):
        return self.client.put(
            f"/api/mushafs/{self.mushaf.id}/pages/1/words", payload, content_type="application/json"
        )

    def test_a_word_moves_between_lines_in_one_call(self):
        response = self._put(
            {
                "lines": [
                    {
                        "line_id": str(self.lines[0].id),
                        "words": [
                            {"word_id": 1, "end_x": 640},
                            {"word_id": 2, "end_x": 520},
                            {"word_id": 3, "end_x": 400},
                            {"word_id": 4, "end_x": 280},
                        ],
                    },
                    {
                        "line_id": str(self.lines[1].id),
                        "words": [
                            {"word_id": 5, "end_x": 660},
                            {"word_id": 6, "end_x": 640},
                            {"word_id": 7, "end_x": 480},
                            {"word_id": 8, "end_x": 320},
                        ],
                    },
                ]
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row.word_id for row in self.lines[0].words.all()], [1, 2, 3, 4])
        self.assertEqual([row.word_id for row in self.lines[1].words.all()], [5, 6, 7, 8])
        self.assertEqual(response.json()["issues"], [])

    def test_the_move_never_leaves_the_word_on_both_lines_or_neither(self):
        """One transaction over both lines is the whole reason for the shape."""
        self._put(
            {
                "lines": [
                    {"line_id": str(self.lines[0].id), "words": _cuts([1, 2, 3, 4], 640, 120)},
                    {"line_id": str(self.lines[1].id), "words": _cuts([5, 6, 7, 8], 660, 100)},
                ]
            }
        )
        self.assertEqual(LineWord.objects.filter(word_id=5).count(), 1)

    def test_a_word_the_text_does_not_have_can_be_added(self):
        """A riwaya may print a word the Hafs list lacks. The cut is the product."""
        response = self._put(
            {
                "lines": [
                    {
                        "line_id": str(self.lines[0].id),
                        "words": [
                            {"word_id": 1, "end_x": 640},
                            {"word_id": None, "end_x": 580},
                            {"word_id": 2, "end_x": 520},
                        ],
                    }
                ]
            }
        )
        self.assertEqual(response.status_code, 200)
        words = response.json()["lines"][0]["words"]
        self.assertEqual([w["end_x"] for w in words], [640, 580, 520])
        self.assertIsNone(words[1]["word_id"])

    def test_an_added_word_is_not_reported_as_a_gap(self):
        self._put(
            {
                "lines": [
                    {
                        "line_id": str(self.lines[0].id),
                        "words": [
                            {"word_id": 1, "end_x": 640},
                            {"word_id": None, "end_x": 580},
                            {"word_id": 2, "end_x": 520},
                            {"word_id": 3, "end_x": 400},
                            {"word_id": 4, "end_x": 280},
                        ],
                    },
                    {"line_id": str(self.lines[1].id), "words": _cuts([5, 6, 7, 8], 660, 100)},
                ]
            }
        )
        issues = self.client.get(f"/api/mushafs/{self.mushaf.id}/pages/1/words").json()["issues"]
        self.assertEqual([issue for issue in issues if issue["kind"] == "gap"], [])

    def test_the_line_is_marked_as_touched_by_a_person(self):
        self._put({"lines": [{"line_id": str(self.lines[0].id), "words": [{"word_id": 1, "end_x": 640}]}]})
        self.assertTrue(LineWordStatus.objects.get(line=self.lines[0]).edited)

    def test_a_break_is_saved_and_reported_rather_than_refused(self):
        """A reviewer fixing line 1 before line 2 passes through this on purpose."""
        response = self._put(
            {"lines": [{"line_id": str(self.lines[0].id), "words": [{"word_id": 1, "end_x": 640}]}]}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.lines[0].words.count(), 1)
        kinds = {issue["kind"] for issue in response.json()["issues"]}
        self.assertIn("gap", kinds)

    def test_a_word_pushed_past_its_ayas_ornament_is_flagged(self):
        """The anchor check. An aya's ornament is printed on the page and does not
        move, so a cut outside its segment has broken the next aya."""
        Segment.objects.filter(line=self.lines[0]).update(bbox_x=400, bbox_w=300)
        report = word_coordinates.coherence(self.page, self.kufi)
        outside = [issue for issue in report if issue.kind == "outside_aya"]
        self.assertTrue(outside)
        self.assertIn("2:5", outside[0].detail)


class OwnershipTests(WordsApiTestCase):
    def test_another_users_mushaf_is_not_reachable(self):
        other = uuid.uuid4()
        self.assertEqual(self.client.get(f"/api/mushafs/{other}/words/coverage").status_code, 404)

"""Tests for processing many calibration pages in one job, and the readiness meter.

Built on the two drawn pages of ``test_calibration_api``: page 1 holds ayat 2:5-6 and
page 2 ayat 2:7-8, two lines each, three one-PAW words to a line.
"""

from unittest import mock

from django.test import SimpleTestCase

from api.models import CalibrationReview, CalibrationRevision, Page, ProcessJob, Segment
from api.services import calibration as calibration_service
from api.services import calibration_progress as progress
from api.services.calibration_batch import decide_batch_page_when_reached
from api.services.jobs.execution import execute_job
from api.services.jobs.kinds.calibration_batch import start_calibration_batch_job
from api.services.jobs.kinds.calibration_page import start_calibration_page_job
from api.tests.test_calibration_api import DOT, CalibrationApiTestCase, drawn_pages

#: The modules of the two calibration jobs. A job module imports the functions it
#: calls by name, so a test that replaces one of them has to replace it there.
BATCH_JOB = "api.services.jobs.kinds.calibration_batch"
PAGE_JOB = "api.services.jobs.kinds.calibration_page"


class BatchTestCase(CalibrationApiTestCase):
    @property
    def batch_url(self) -> str:
        return f"/api/mushafs/{self.mushaf.id}/calibration/batch"

    def batch(self, first: int = 1, last: int = 2, **extra):
        with drawn_pages():
            return self.client.post(
                self.batch_url, {"first": first, "last": last, **extra}, content_type="application/json"
            )

    def drafted(self, page: int) -> bool:
        review = CalibrationReview.objects.filter(mushaf=self.mushaf, page_number=page).first()
        return bool(review and review.payload.get("lines"))

    def processings(self, page: int) -> int:
        return CalibrationRevision.objects.filter(
            review__mushaf=self.mushaf, review__page_number=page, kind="processed"
        ).count()


class PlanTests(BatchTestCase):
    def test_the_plan_says_what_each_page_would_get_and_starts_nothing(self):
        response = self.batch(dry_run=True)
        self.assertEqual(response.status_code, 200, response.content)
        plan = response.json()
        self.assertEqual(plan["pages"], {"new": [1, 2]})
        self.assertEqual((plan["process"], plan["drafted"]), (2, 0))
        self.assertFalse(ProcessJob.objects.exists())

    def test_pages_review_has_not_finished_are_named_and_left_alone(self):
        Page.objects.filter(mushaf=self.mushaf, page_number=2).update(reviewed=False)
        Segment.objects.filter(line__page__page_number=1, line__line_number=2).update(aya_number=None)
        plan = self.batch(1, 2, dry_run=True).json()
        self.assertEqual(plan["pages"], {"not_numbered": [1], "not_reviewed": [2]})
        self.assertEqual(self.batch(1, 2).status_code, 422)

    def test_a_range_outside_the_mushaf_is_refused(self):
        self.assertEqual(self.batch(2, 1, dry_run=True).status_code, 422)
        self.assertEqual(self.batch(1, 9, dry_run=True).status_code, 422)


class RunTests(BatchTestCase):
    def test_a_batch_processes_every_new_page_in_one_job(self):
        response = self.batch()
        self.assertEqual(response.status_code, 202, response.content)
        job = response.json()["job"]
        self.assertEqual((job["kind"], job["state"], job["pages_saved"]), ("calibration_batch", "completed", 2))
        self.assertEqual(job["report"]["processed"], [1, 2])
        self.assertTrue(self.drafted(1) and self.drafted(2))
        # The one-page screen's poll sees it too.
        polled = self.client.get(f"/api/mushafs/{self.mushaf.id}/calibration/job").json()["job"]
        self.assertEqual(polled["id"], job["id"])

    def test_a_confirmed_page_is_left_alone_and_a_worked_on_draft_keeps_its_decisions(self):
        """A draft someone worked on is a draft like any other: processed again on
        request, with the decisions on its blobs put back. Only confirming a page
        keeps it from being processed over."""
        self.process(1)
        self.assertEqual(self.confirm(1, self.draft(self.document(1))).status_code, 200)
        self.process(2)
        document = self.document(2)
        body = self.draft(document)
        dot = self.blob_at(document["lines"][0], DOT[0])["id"]
        next(blob for blob in body["lines"][0]["blobs"] if blob["id"] == dot).update(
            role="mark", explicit=True, subtype="ijamDot"
        )
        self.assertEqual(self.put(2, body).status_code, 200)
        self.assertEqual(self.batch(dry_run=True).json()["pages"], {"confirmed": [1], "drafted": [2]})
        report = self.batch(refresh=True).json()["job"]["report"]
        self.assertEqual((report["processed"], report["skipped"]), ([2], {"confirmed": [1]}))
        self.assertEqual((self.processings(1), self.processings(2)), (1, 2))
        kept = self.blob_at(self.document(2)["lines"][0], DOT[0])
        self.assertEqual((kept["explicit"], kept["subtype"], kept["decision_source"]), (True, "ijamDot", "human"))

    def test_a_current_draft_is_kept_or_refreshed_on_request(self):
        self.process(1)
        response = self.batch()
        report = response.json()["job"]["report"]
        self.assertEqual((report["processed"], report["skipped"]), ([2], {"current": [1]}))
        self.assertEqual(self.processings(1), 1)

        report = self.batch(refresh=True).json()["job"]["report"]
        self.assertEqual(report["processed"], [1, 2])
        self.assertEqual((self.processings(1), self.processings(2)), (2, 2))

    def test_a_draft_whose_lines_changed_is_processed_again(self):
        self.process(1)
        self.process(2)
        Segment.objects.filter(line__page__page_number=1, line__line_number=1).update(bbox_w=480)
        self.assertEqual(self.batch(dry_run=True).json()["pages"], {"drafted": [1, 2]})
        report = self.batch().json()["job"]["report"]
        self.assertEqual((report["processed"], report["skipped"]), ([1], {"current": [2]}))
        self.assertFalse(self.document(1)["stale"])

    def test_a_draft_saved_after_it_was_decided_is_not_processed_over(self):
        self.process(2)
        document = self.document(2)

        def decide_then_save(mushaf, number, *, refresh):
            decided = decide_batch_page_when_reached(mushaf, number, refresh=refresh)
            # Someone saves page 2 after the batch decided it, before it is stored.
            if number == 2:
                calibration_service.save(mushaf, 2, self.draft(document), user=self.user)
            return decided

        with mock.patch(f"{BATCH_JOB}.decide_batch_page_when_reached", side_effect=decide_then_save):
            report = self.batch(refresh=True).json()["job"]["report"]
        self.assertEqual(report["processed"], [1])
        self.assertEqual([failure["page"] for failure in report["failed"]], [2])
        self.assertEqual(self.processings(2), 1)

    def test_a_stop_ends_the_batch_between_pages_and_keeps_what_it_did(self):
        def stop_once_page_1_is_stored(job_id):
            return self.drafted(1)

        with mock.patch(f"{BATCH_JOB}.is_job_cancellation_requested", side_effect=stop_once_page_1_is_stored):
            job = self.batch().json()["job"]
        self.assertEqual((job["state"], job["report"]["processed"]), ("cancelled", [1]))
        self.assertFalse(self.drafted(2))

    def test_one_failing_page_does_not_cost_the_rest(self):
        real = calibration_service.process_page

        def fail_page_1(mushaf, page, **kwargs):
            if page == 1:
                raise RuntimeError("boom")
            return real(mushaf, page, **kwargs)

        with (
            mock.patch(f"{BATCH_JOB}.process_page", side_effect=fail_page_1),
            self.assertLogs(BATCH_JOB, level="ERROR"),
        ):
            job = self.batch().json()["job"]
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["report"]["processed"], [2])
        self.assertEqual(job["report"]["failed"], [{"page": 1, "error": "boom"}])

    def test_a_second_run_is_refused_while_one_is_working(self):
        ProcessJob.objects.create(mushaf=self.mushaf, page_range_start=1, page_range_end=1, kind="calibration")
        self.assertEqual(self.batch().status_code, 409)


class JobsFromTheirRowTests(BatchTestCase):
    """A worker is handed the job's id and nothing else: the row has to say the rest."""

    @staticmethod
    def queued_only(module: str):
        """The request half, stopped short of the dispatch: only the row exists."""
        return mock.patch(f"{module}.dispatch_job", side_effect=lambda job, **_: job)

    def test_a_calibration_page_job_runs_from_its_row_alone(self):
        with self.queued_only(PAGE_JOB):
            job = start_calibration_page_job(self.mushaf, 1, user=self.user)
        self.assertEqual((job.state, job.params), ("queued", {"page": 1, "expected_revision": 0}))
        self.assertFalse(self.drafted(1))

        with drawn_pages():
            execute_job(job.id, "worker-a")

        job.refresh_from_db()
        self.assertEqual((job.state, job.pages_saved, job.claimed_by_worker), ("completed", 1, "worker-a"))
        self.assertTrue(self.drafted(1))

    def test_a_calibration_batch_job_runs_from_its_row_alone(self):
        with self.queued_only(BATCH_JOB):
            job = start_calibration_batch_job(self.mushaf, 1, 2, user=self.user)
        self.assertEqual((job.state, job.params), ("queued", {"refresh": False}))
        self.assertFalse(self.drafted(1) or self.drafted(2))

        with drawn_pages():
            execute_job(job.id, "worker-a")

        job.refresh_from_db()
        self.assertEqual((job.state, job.report["processed"]), ("completed", [1, 2]))
        self.assertTrue(self.drafted(1) and self.drafted(2))

    def test_a_page_job_whose_draft_was_saved_while_it_waited_settles_as_error(self):
        """The row carries the draft revision the request saw. A draft saved while the
        job waited in the queue is not processed over."""
        self.process(1)
        Segment.objects.filter(line__page__page_number=1, line__line_number=1).update(bbox_w=480)
        with self.queued_only(PAGE_JOB):
            job = start_calibration_page_job(self.mushaf, 1, user=self.user)
        CalibrationReview.objects.filter(mushaf=self.mushaf, page_number=1).update(
            revision=job.params["expected_revision"] + 1
        )

        with drawn_pages(), self.assertLogs("api.services.jobs.execution", level="ERROR"):
            execute_job(job.id, "worker-a")

        job.refresh_from_db()
        self.assertEqual(job.state, "error")
        self.assertEqual(self.processings(1), 1)


class ReadinessApiTests(BatchTestCase):
    def test_the_meter_starts_empty_and_counts_each_confirmed_page(self):
        url = f"/api/mushafs/{self.mushaf.id}/calibration/readiness"
        empty = self.client.get(url).json()
        self.assertEqual((empty["score"], empty["level"], empty["pages"]), (0, "keep", []))
        self.assertEqual([check["state"] for check in empty["checks"]], ["fail", "unknown", "unknown", "unknown"])

        self.process(1)
        self.assertEqual(self.confirm(1, self.draft(self.document(1))).status_code, 200)
        meter = self.client.get(url).json()
        [page] = meter["pages"]
        self.assertEqual((page["page"], page["fixes"], page["coverage"]), (1, 0, 0.0))
        self.assertEqual(meter["checks"][0]["values"], {"count": 1, "target": progress.ENOUGH_PAGES})
        self.assertIsNotNone(meter["cost"]["process_seconds"])


def _row(page: int, *, learned: int = 600, wrong: int = 0, fixes: int = 5, blobs: int = 1000) -> dict:
    return {
        "page": page,
        "blobs": blobs,
        "words_total": 130,
        "engine_wrong": 6,
        "learned": learned,
        "learned_wrong": wrong,
        "minutes": 7,
        "first_draft": True,
        "looks": 10,
        "roles": fixes,
        "by_text": 600,
        "text_changed": 0,
        "locks": 2,
        "locks_undone": 0,
        "by_hand": 0,
        "words": 8,
    }


class ReadinessCheckTests(SimpleTestCase):
    def test_enough_pages_and_a_settled_trusted_learning_read_ready(self):
        rows = [_row(page, learned=700 + page) for page in range(3, 12)]
        checks = [
            progress._pages_check(len(rows)),
            progress._trust_check(rows),
            progress._settled_check(rows),
            progress._fixes_check(rows),
        ]
        self.assertEqual([check["state"] for check in checks], ["pass", "pass", "pass", "pass"])
        self.assertEqual(checks[2]["values"]["growth"], 0.1)

    def test_a_learning_still_climbing_is_not_settled(self):
        rows = [_row(page, learned=100 + 150 * page) for page in range(1, 6)]
        settled = progress._settled_check(rows)
        self.assertEqual((settled["state"], settled["score"], settled["values"]["growth"]), ("fail", 0.0, 15.0))

    def test_wrong_proposals_cost_trust_in_proportion(self):
        near = progress._trust_check([_row(1, learned=1000, wrong=1)])
        self.assertEqual((near["state"], near["score"]), ("near", 0.95))
        failing = progress._trust_check([_row(1, learned=100, wrong=1)])
        self.assertEqual((failing["state"], failing["score"]), ("fail", 0.5))

    def test_fixes_are_counted_per_thousand_blobs_of_the_latest_first_drafts(self):
        rows = [_row(1, fixes=100), _row(2, fixes=10), _row(3, fixes=10), _row(4, fixes=10)]
        fixes = progress._fixes_check(rows)
        self.assertEqual((fixes["values"]["rate"], fixes["values"]["per_page"], fixes["state"]), (10.0, 10.0, "near"))

    def test_too_few_pages_to_tell_is_unknown_not_failing(self):
        rows = [_row(1), _row(2)]
        self.assertEqual(progress._settled_check(rows)["state"], "unknown")
        self.assertEqual(progress._fixes_check([])["state"], "unknown")


class ReadinessScoreTests(CalibrationApiTestCase):
    def test_a_failing_trust_holds_the_meter_under_close(self):
        rows = [_row(page, learned=100, wrong=5) for page in range(1, 10)]
        with mock.patch.object(progress, "measure", return_value=rows):
            meter = progress.readiness(self.mushaf)
        self.assertEqual(meter["checks"][1]["state"], "fail")
        self.assertLess(meter["score"], progress.CLOSE)
        self.assertEqual(meter["level"], "keep")

    def test_the_rows_behind_the_meter_are_the_report_command_rows(self):
        from api.management.commands import calibration_report

        self.assertIs(calibration_report.measure, progress.measure)

"""Tests for background processing jobs: the job system, cancellation, endpoints.

Two layers, deliberately separated:

* Job-system tests drive :mod:`api.services.jobs` with a *fake* runner on a real
  worker thread. They use a TransactionTestCase because job state is a database
  row: a worker thread has its own connection and cannot see writes still sitting
  in a TestCase's uncommitted transaction.
* Endpoint tests run jobs inline (``PROCESS_JOBS_INLINE``), so a POST settles
  before it returns and assertions need no waiting.
"""

import uuid
from datetime import timedelta
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from ninja.errors import HttpError

from api.models import ProcessingRun, ProcessJob, RunStatusChoices
from api.services import mushaf as mushaf_service
from api.services import processing as processing_service
from api.services.jobs.admission import refuse_if_mushaf_has_active_job
from api.services.jobs.cancellation import request_job_cancellation
from api.services.jobs.claiming import claim_queued_job
from api.services.jobs.dead_jobs import mark_silent_jobs_interrupted, mark_unclaimed_jobs_interrupted
from api.services.jobs.dispatch import THREAD
from api.services.jobs.execution import execute_job
from api.services.jobs.kinds.detection import start_detection_job
from api.services.jobs.queries import find_active_job_of_mushaf, find_job_by_id, find_latest_job_of_mushaf
from api.services.jobs.runner_registry import JOB_RUNNER_PATHS, load_job_runner
from api.tests.helpers import (
    JOB_TIMEOUT,
    ApiTestCase,
    FakeJobRunners,
    GatedRunner,
    MediaTestCase,
    MediaTransactionTestCase,
    bare_mushaf,
    complete_job_at_once,
    create_job_row,
    default_user,
    delete_all_jobs,
    make_pdf_bytes,
    make_png_bytes,
    make_user,
    wait_until_job_finished,
)
from quran.services import suras

_SETTINGS = {
    "start_sura": 2,
    "start_aya": 1,
    "bounds": {"x": 50, "y": 50, "w": 500, "h": 500},
    "padding": 4,
    "expected_lines": 15,
    "sura_header_slots": 1,
    "sura_header_threshold": 0.6,
    "max_sura_headers": 3,
    "match_threshold": 0.5,
    "alternate_horizontal_margin": False,
    "prefer_acceleration": False,
}


def _mushaf(pages: int = 3):
    created = mushaf_service.create_mushaf(
        owner=default_user(),
        pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(pages), "application/pdf"),
        name="Jobs",
        qiraa=None,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )
    return mushaf_service.get_mushaf(created["mushaf"]["id"], user=default_user())


def _add_templates(mushaf):
    for template_type in ("sura_header", "aya_separator"):
        mushaf_service.upsert_template(
            mushaf_id=mushaf.id,
            template_type=template_type,
            image=SimpleUploadedFile(f"{template_type}.png", make_png_bytes((40, 40)), "image/png"),
            ignore_x=None,
            ignore_y=None,
            ignore_w=None,
            ignore_h=None,
            user=default_user(),
        )


def _params(start: int = 1, end: int = 1) -> dict:
    return {"page_range_start": start, "page_range_end": end, **_SETTINGS}


@override_settings(MAX_CONCURRENT_JOBS=10, MAX_CONCURRENT_JOBS_PER_USER=10)
class JobSystemTests(FakeJobRunners, MediaTransactionTestCase):
    """The job system, exercised across a real worker thread.

    The caps are lifted here so these tests are about the job system rather than
    about throttling; ConcurrencyCapTests covers the caps themselves.
    """

    def test_start_returns_a_running_job_and_is_findable_by_mushaf(self):
        mushaf = bare_mushaf()
        gate = GatedRunner()
        job = self.start_job_with_runner(mushaf, gate, first_page=3, last_page=12)
        self.addCleanup(gate.release.set)

        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))
        job.refresh_from_db()
        self.assertEqual(job.state, "running")
        self.assertEqual(job.total, 10)
        self.assertEqual((job.page_range_start, job.page_range_end), (3, 12))
        # Found without the client having to remember the job id.
        self.assertEqual(find_latest_job_of_mushaf(mushaf.id).id, job.id)
        self.assertEqual(find_active_job_of_mushaf(mushaf.id).id, job.id)

    def test_second_start_for_the_same_mushaf_is_rejected(self):
        mushaf = bare_mushaf()
        gate = GatedRunner()
        self.start_job_with_runner(mushaf, gate)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))

        with self.assertRaises(HttpError) as caught:
            self.start_job_with_runner(mushaf, GatedRunner())
        self.assertEqual(caught.exception.status_code, 409)

    def test_another_mushaf_may_run_at_the_same_time(self):
        first, second = bare_mushaf("A"), bare_mushaf("B")
        gate_a, gate_b = GatedRunner(), GatedRunner()
        self.start_job_with_runner(first, gate_a)
        self.start_job_with_runner(second, gate_b)
        self.addCleanup(gate_a.release.set)
        self.addCleanup(gate_b.release.set)

        self.assertTrue(gate_a.entered.wait(JOB_TIMEOUT))
        self.assertTrue(gate_b.entered.wait(JOB_TIMEOUT))
        self.assertIsNotNone(find_active_job_of_mushaf(first.id))
        self.assertIsNotNone(find_active_job_of_mushaf(second.id))

    def test_cancel_flags_the_job_and_the_worker_sees_the_event(self):
        mushaf = bare_mushaf()
        gate = GatedRunner()
        job = self.start_job_with_runner(mushaf, gate)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))

        returned = request_job_cancellation(mushaf.id)

        self.assertEqual(returned.id, job.id)
        job.refresh_from_db()
        self.assertTrue(job.cancel_requested)
        # Still "running": a cooperative cancel settles only when the work stops.
        self.assertEqual(job.state, "running")

        gate.release.set()
        wait_until_job_finished(self, job)
        self.assertTrue(gate.saw_cancel)
        self.assertEqual(job.state, "cancelled")
        self.assertIsNone(find_active_job_of_mushaf(mushaf.id))

    def test_cancel_without_a_running_job_is_404(self):
        mushaf = bare_mushaf()
        with self.assertRaises(HttpError) as caught:
            request_job_cancellation(mushaf.id)
        self.assertEqual(caught.exception.status_code, 404)

    def test_a_settled_job_stays_visible_and_a_new_one_replaces_it(self):
        mushaf = bare_mushaf()
        first = self.start_job_with_runner(mushaf, complete_job_at_once)
        wait_until_job_finished(self, first)
        self.assertEqual(find_latest_job_of_mushaf(mushaf.id).id, first.id)

        second = self.start_job_with_runner(mushaf, complete_job_at_once)
        wait_until_job_finished(self, second)
        self.assertEqual(find_latest_job_of_mushaf(mushaf.id).id, second.id)
        # Rows are kept rather than dropped: unlike the old in-memory dict, the
        # table is a run history worth having, and it grows only per run.
        self.assertIsNotNone(find_job_by_id(first.id))

    def test_a_raising_runner_settles_the_job_as_error(self):
        mushaf = bare_mushaf()

        def boom(job):
            raise RuntimeError("engine exploded")

        job = self.start_job_with_runner(mushaf, boom)
        wait_until_job_finished(self, job)

        self.assertEqual(job.state, "error")
        self.assertEqual(job.error, "engine exploded")
        self.assertIsNotNone(job.ended_at)

    def test_a_runner_that_forgets_to_settle_is_not_left_running(self):
        mushaf = bare_mushaf()
        job = self.start_job_with_runner(mushaf, lambda job: None)
        wait_until_job_finished(self, job)

        self.assertEqual(job.state, "error")
        self.assertIsNotNone(job.error)


class ProcessCancellationTests(MediaTestCase):
    """The service path: what a cancelled run leaves behind in the database."""

    def setUp(self):
        suras.seed_reference_data()
        delete_all_jobs()
        self.addCleanup(delete_all_jobs)

    def test_cancelled_run_is_recorded_and_saves_nothing_it_did_not_finish(self):
        mushaf = _mushaf(pages=3)
        _add_templates(mushaf)

        result = processing_service.process(
            mushaf, page_range_start=1, page_range_end=3, should_cancel=lambda: True, **_SETTINGS
        )

        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["pages_saved"], 0)
        self.assertEqual(result["stopped_on_page"], 1)
        self.assertEqual(result["cancel_info"], {"page_index": 1, "filename": "1.png"})
        run = ProcessingRun.objects.get(mushaf=mushaf)
        self.assertEqual(run.status, RunStatusChoices.CANCELLED)
        self.assertEqual(mushaf.pages.count(), 0)

    def test_progress_is_reported_before_each_render(self):
        mushaf = _mushaf(pages=3)
        _add_templates(mushaf)
        seen: list[tuple[str, int | None, int]] = []

        processing_service.process(
            mushaf,
            page_range_start=1,
            page_range_end=2,
            on_progress=lambda phase, page, saved: seen.append((phase, page, saved)),
            **_SETTINGS,
        )

        self.assertIn(("rendering", 1, 0), seen)
        self.assertIn(("detecting", 1, 0), seen)

    def test_abort_reports_where_it_stopped(self):
        # The stub PDF has no real Quran layout, so page 1 fails line detection.
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)

        result = processing_service.process(mushaf, page_range_start=1, page_range_end=2, **_SETTINGS)

        self.assertEqual(result["status"], "aborted_line_detection")
        self.assertEqual(result["stopped_on_page"], 1)
        self.assertEqual(result["pages_saved"], 0)
        self.assertEqual(ProcessingRun.objects.get(mushaf=mushaf).status, RunStatusChoices.ABORTED_LINE_DETECTION)

    def test_stale_running_rows_are_settled_by_the_next_run(self):
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)
        orphan = ProcessingRun.objects.create(
            mushaf=mushaf,
            settings={},
            page_range_start=1,
            page_range_end=1,
            status=RunStatusChoices.RUNNING,
        )

        processing_service.process(
            mushaf, page_range_start=1, page_range_end=1, should_cancel=lambda: True, **_SETTINGS
        )

        orphan.refresh_from_db()
        self.assertEqual(orphan.status, RunStatusChoices.INTERRUPTED)


@override_settings(PROCESS_JOBS_INLINE=True)
class ProcessEndpointTests(ApiTestCase):
    """The HTTP contract: start / poll / cancel."""

    def setUp(self):
        super().setUp()  # signs the client in; without it every call 401s
        suras.seed_reference_data()
        delete_all_jobs()
        self.addCleanup(delete_all_jobs)

    def _start(self, mushaf, start: int = 1, end: int = 1):
        return self.client.post(
            f"/api/mushafs/{mushaf.id}/process",
            data=_params(start, end),
            content_type="application/json",
        )

    def test_post_accepts_the_run_and_returns_the_job(self):
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)

        resp = self._start(mushaf)

        self.assertEqual(resp.status_code, 202)
        body = resp.json()
        self.assertEqual(body["mushaf_id"], str(mushaf.id))
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["phase"], "finished")  # inline: already settled
        self.assertIn(body["state"], {"completed", "aborted_line_detection"})
        self.assertIsNotNone(body["run_id"])
        self.assertIsNotNone(body["log_url"])

    def test_post_without_templates_is_rejected(self):
        mushaf = _mushaf(pages=2)
        resp = self._start(mushaf)
        self.assertEqual(resp.status_code, 400)

    def test_poll_returns_the_latest_job(self):
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)
        started = self._start(mushaf).json()

        resp = self.client.get(f"/api/mushafs/{mushaf.id}/process/job")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["job"]["id"], started["id"])

    def test_poll_with_no_job_on_record_is_an_empty_200(self):
        resp = self.client.get(f"/api/mushafs/{uuid.uuid4()}/process/job")
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["job"])

    def test_cancel_with_nothing_running_is_404(self):
        mushaf = _mushaf(pages=2)
        resp = self.client.post(f"/api/mushafs/{mushaf.id}/process/cancel")
        self.assertEqual(resp.status_code, 404)


@override_settings(MAX_CONCURRENT_JOBS=10, MAX_CONCURRENT_JOBS_PER_USER=10)
class ThreadedEndpointTests(FakeJobRunners, MediaTransactionTestCase):
    """HTTP against a job on a real worker thread.

    Separate from ProcessEndpointTests because a running worker needs committed
    rows to look itself up — see MediaTransactionTestCase.
    """

    def setUp(self):
        super().setUp()
        self.user = default_user()
        self.client.force_login(self.user)

    def test_cancel_a_running_job_returns_it_flagged(self):
        mushaf = bare_mushaf()
        gate = GatedRunner()
        self.start_job_with_runner(mushaf, gate, job_runner=THREAD)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))

        resp = self.client.post(f"/api/mushafs/{mushaf.id}/process/cancel")

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["cancel_requested"])
        self.assertEqual(body["state"], "running")

    def test_starting_while_one_is_running_is_409(self):
        mushaf = bare_mushaf()
        gate = GatedRunner()
        self.start_job_with_runner(mushaf, gate, job_runner=THREAD)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))

        resp = self.client.post(
            f"/api/mushafs/{mushaf.id}/process",
            data=_params(),
            content_type="application/json",
        )

        self.assertEqual(resp.status_code, 409)


class ConcurrencyCapTests(FakeJobRunners, MediaTransactionTestCase):
    """Detection is CPU-bound, so the number of runs at once has to be bounded."""

    @override_settings(MAX_CONCURRENT_JOBS=1, MAX_CONCURRENT_JOBS_PER_USER=10)
    def test_the_overall_cap_is_enforced_across_mushafs(self):
        first, second = bare_mushaf("A"), bare_mushaf("B")
        gate = GatedRunner()
        self.start_job_with_runner(first, gate)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))

        with self.assertRaises(HttpError) as caught:
            self.start_job_with_runner(second, GatedRunner())
        self.assertEqual(caught.exception.status_code, 429)

    @override_settings(MAX_CONCURRENT_JOBS=10, MAX_CONCURRENT_JOBS_PER_USER=1)
    def test_the_per_user_cap_only_blocks_that_user(self):
        alice = default_user()
        bob = make_user("bob@example.com")
        first, second, third = bare_mushaf("A", owner=alice), bare_mushaf("B", owner=alice), bare_mushaf("C", owner=bob)
        gate = GatedRunner()
        self.start_job_with_runner(first, gate, user=alice)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))

        with self.assertRaises(HttpError) as caught:
            self.start_job_with_runner(second, GatedRunner(), user=alice)
        self.assertEqual(caught.exception.status_code, 429)

        # Bob is unaffected by Alice's usage.
        other_gate = GatedRunner()
        self.start_job_with_runner(third, other_gate, user=bob)
        self.addCleanup(other_gate.release.set)
        self.assertTrue(other_gate.entered.wait(JOB_TIMEOUT))

    @override_settings(MAX_CONCURRENT_JOBS=1, MAX_CONCURRENT_JOBS_PER_USER=10)
    def test_a_settled_job_frees_its_slot(self):
        first, second = bare_mushaf("A"), bare_mushaf("B")
        self.start_job_with_runner(first, complete_job_at_once)
        wait_until_job_finished(self, find_latest_job_of_mushaf(first.id))

        gate = GatedRunner()
        self.start_job_with_runner(second, gate)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(JOB_TIMEOUT))


class HeartbeatTests(MediaTestCase):
    """A job whose worker died must not block its mushaf forever."""

    def setUp(self):
        delete_all_jobs()
        self.addCleanup(delete_all_jobs)

    def _orphan(self, mushaf, *, age_seconds: int):
        """A 'running' row whose worker last reported `age_seconds` ago."""
        return ProcessJob.objects.create(
            mushaf=mushaf,
            state="running",
            page_range_start=1,
            page_range_end=1,
            total=1,
            run_started_at=timezone.now() - timedelta(seconds=age_seconds),
            heartbeat_at=timezone.now() - timedelta(seconds=age_seconds),
        )

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_silent_job_is_settled_as_interrupted(self):
        mushaf = bare_mushaf()
        job = self._orphan(mushaf, age_seconds=600)

        self.assertIsNone(find_active_job_of_mushaf(mushaf.id))

        job.refresh_from_db()
        self.assertEqual(job.state, "interrupted")
        self.assertIsNotNone(job.ended_at)

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_recently_seen_job_is_left_alone(self):
        """A slow page must not be mistaken for a dead worker."""
        mushaf = bare_mushaf()
        job = self._orphan(mushaf, age_seconds=5)

        self.assertIsNotNone(find_active_job_of_mushaf(mushaf.id))

        job.refresh_from_db()
        self.assertEqual(job.state, "running")

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_dead_job_stops_blocking_new_runs(self):
        mushaf = bare_mushaf()
        self._orphan(mushaf, age_seconds=600)

        # Would raise 409 if the corpse still counted as running.
        refuse_if_mushaf_has_active_job(mushaf.id)

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_queued_job_is_never_silent(self):
        """Silence is a worker's. A job that waits for one has nobody to report for it."""
        mushaf = bare_mushaf()
        job = create_job_row(mushaf)
        ProcessJob.objects.filter(pk=job.pk).update(heartbeat_at=timezone.now() - timedelta(seconds=600))

        self.assertEqual(mark_silent_jobs_interrupted(), 0)

        job.refresh_from_db()
        self.assertEqual(job.state, "queued")


@override_settings(JOB_QUEUE_TIMEOUT_SECONDS=600, MAX_CONCURRENT_JOBS=1)
class UnclaimedJobTests(MediaTestCase):
    """A queued job that no worker picks up must not hold its mushaf for ever. A
    job that only waits its turn must be left alone."""

    def setUp(self):
        delete_all_jobs()
        self.addCleanup(delete_all_jobs)

    def _queued(self, mushaf, *, waited_seconds: int):
        job = create_job_row(mushaf)
        ProcessJob.objects.filter(pk=job.pk).update(requested_at=timezone.now() - timedelta(seconds=waited_seconds))
        return job

    def _ran(self, mushaf, *, ended_seconds_ago: int | None):
        """A job that held the one slot: still running, or ended that long ago."""
        now = timezone.now()
        return ProcessJob.objects.create(
            mushaf=mushaf,
            state="running" if ended_seconds_ago is None else "completed",
            page_range_start=1,
            page_range_end=1,
            run_started_at=now - timedelta(seconds=3600),
            heartbeat_at=now,
            ended_at=None if ended_seconds_ago is None else now - timedelta(seconds=ended_seconds_ago),
        )

    def test_a_job_nothing_claimed_while_a_slot_stood_free_is_interrupted(self):
        mushaf = bare_mushaf()
        job = self._queued(mushaf, waited_seconds=700)

        self.assertIsNone(find_active_job_of_mushaf(mushaf.id))

        job.refresh_from_db()
        self.assertEqual(job.state, "interrupted")
        self.assertEqual(job.error, "No worker picked this job up.")
        self.assertIsNotNone(job.ended_at)
        # The mushaf is free again.
        refuse_if_mushaf_has_active_job(mushaf.id)

    def test_a_job_waiting_behind_a_running_job_is_left_alone(self):
        """Waiting alone is not an error: a job may wait hours behind a long run."""
        job = self._queued(bare_mushaf("A"), waited_seconds=7200)
        self._ran(bare_mushaf("B"), ended_seconds_ago=None)

        self.assertEqual(mark_unclaimed_jobs_interrupted(), 0)

        job.refresh_from_db()
        self.assertEqual(job.state, "queued")

    def test_the_wait_is_counted_from_when_the_slot_came_free(self):
        """The slot was busy until a minute ago, so a worker has had one minute, not
        ten, to pick the job up."""
        job = self._queued(bare_mushaf("A"), waited_seconds=7200)
        self._ran(bare_mushaf("B"), ended_seconds_ago=60)

        self.assertEqual(mark_unclaimed_jobs_interrupted(), 0)

        job.refresh_from_db()
        self.assertEqual(job.state, "queued")

    def test_a_job_requested_a_moment_ago_is_left_alone(self):
        job = self._queued(bare_mushaf(), waited_seconds=5)

        self.assertEqual(mark_unclaimed_jobs_interrupted(), 0)

        job.refresh_from_db()
        self.assertEqual(job.state, "queued")


class ClaimTests(FakeJobRunners, MediaTestCase):
    """A job runs once, however often it is delivered, and only while it is queued."""

    def test_a_new_job_is_queued_and_describes_itself(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf, user=default_user())

        self.assertEqual(job.state, "queued")
        self.assertIsNone(job.run_started_at)
        self.assertEqual(job.claimed_by_worker, "")
        self.assertEqual(job.requested_by, default_user())
        # Queued is not final: the mushaf is held from the moment the job exists.
        self.assertEqual(find_active_job_of_mushaf(mushaf.id).id, job.id)

    def test_a_claim_marks_the_job_running_on_that_worker(self):
        job = create_job_row(bare_mushaf())

        claimed = claim_queued_job(job.id, "worker-a")

        self.assertEqual(claimed.id, job.id)
        self.assertEqual((claimed.state, claimed.claimed_by_worker), ("running", "worker-a"))
        self.assertIsNotNone(claimed.run_started_at)
        self.assertIsNotNone(claimed.heartbeat_at)

    def test_a_job_claimed_twice_runs_once(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf)
        runs: list[str] = []

        def count_the_run(job):
            runs.append(job.claimed_by_worker)
            complete_job_at_once(job)

        self.runner_of_mushaf[mushaf.id] = count_the_run
        execute_job(job.id, "worker-a")
        # The same job delivered again: to another worker, then to the first one.
        execute_job(job.id, "worker-b")
        execute_job(job.id, "worker-a")

        self.assertEqual(runs, ["worker-a"])
        self.assertIsNone(claim_queued_job(job.id, "worker-b"))
        job.refresh_from_db()
        self.assertEqual((job.state, job.claimed_by_worker), ("completed", "worker-a"))

    def test_a_kind_without_a_runner_settles_as_error(self):
        job = create_job_row(bare_mushaf())
        ProcessJob.objects.filter(pk=job.pk).update(kind="words")

        with mock.patch("api.services.jobs.execution.load_job_runner", load_job_runner), self.assertLogs(level="ERROR"):
            execute_job(job.id, "worker-a")

        job.refresh_from_db()
        self.assertEqual(job.state, "error")
        self.assertIn("words", job.error)

    def test_every_registered_runner_can_be_loaded(self):
        for kind in JOB_RUNNER_PATHS:
            self.assertTrue(callable(load_job_runner(kind)), kind)


class QueuedCancelTests(FakeJobRunners, ApiTestCase):
    """A queued job has done nothing yet, so a cancel settles it at once."""

    def test_a_queued_job_is_cancelled_directly(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf)

        returned = request_job_cancellation(mushaf.id)

        self.assertEqual(returned.id, job.id)
        self.assertEqual((returned.state, returned.phase), ("cancelled", "finished"))
        self.assertTrue(returned.cancel_requested)
        self.assertIsNotNone(returned.ended_at)
        self.assertIsNone(returned.run_started_at)
        self.assertIsNone(find_active_job_of_mushaf(mushaf.id))

    def test_a_job_cancelled_while_queued_never_runs(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf)
        runs: list[str] = []
        self.runner_of_mushaf[mushaf.id] = lambda job: runs.append("ran")
        request_job_cancellation(mushaf.id)

        # The worker gets to the job after the cancel.
        execute_job(job.id, "worker-a")

        self.assertEqual(runs, [])
        job.refresh_from_db()
        self.assertEqual((job.state, job.claimed_by_worker), ("cancelled", ""))

    def test_the_cancel_endpoint_answers_with_the_cancelled_job(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf, user=self.user)

        resp = self.client.post(f"/api/mushafs/{mushaf.id}/process/cancel")

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual((body["id"], body["state"]), (str(job.id), "cancelled"))
        self.assertIsNone(body["run_started_at"])
        self.assertIsNotNone(body["requested_at"])


class DetectionFromItsRowTests(MediaTestCase):
    """A worker is handed the job's id and nothing else."""

    def setUp(self):
        suras.seed_reference_data()
        delete_all_jobs()
        self.addCleanup(delete_all_jobs)

    def test_a_detection_job_runs_from_its_row_alone(self):
        mushaf = _mushaf(pages=2)
        _add_templates(mushaf)
        # The request half, stopped short of the dispatch: the row is all there is.
        with mock.patch("api.services.jobs.kinds.detection.dispatch_job", side_effect=lambda job, **_: job):
            job = start_detection_job(mushaf, _params(1, 2), user=default_user())
        self.assertEqual(job.state, "queued")
        self.assertEqual(job.params, _params(1, 2))

        execute_job(job.id, "worker-a")

        job.refresh_from_db()
        # The stub PDF has no real Quran layout, so page 1 fails line detection.
        self.assertEqual(job.state, "aborted_line_detection")
        self.assertEqual((job.claimed_by_worker, job.stopped_on_page), ("worker-a", 1))
        self.assertIsNotNone(job.run_id)
        self.assertIsNotNone(job.run_started_at)

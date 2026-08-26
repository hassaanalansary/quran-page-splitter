"""Tests for background processing jobs: the registry, cancellation, endpoints.

Two layers, deliberately separated:

* Registry tests drive :mod:`api.services.jobs` with a *fake* runner on a real
  worker thread. They use a TransactionTestCase because job state is now a
  database row: a worker thread has its own connection and cannot see writes
  still sitting in a TestCase's uncommitted transaction.
* Endpoint tests run jobs inline (``PROCESS_JOBS_INLINE``), so a POST settles
  before it returns and assertions need no waiting.
"""

import threading
import uuid
from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from ninja.errors import HttpError

from api.models import ProcessingRun, ProcessJob, RunStatusChoices
from api.services import jobs as jobs_service
from api.services import mushaf as mushaf_service
from api.services import processing as processing_service
from api.services import suras
from api.tests.helpers import (
    ApiTestCase,
    MediaTestCase,
    MediaTransactionTestCase,
    bare_mushaf,
    default_user,
    make_pdf_bytes,
    make_png_bytes,
    make_user,
)

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

_TIMEOUT = 10  # seconds; generous so a slow CI box doesn't flake


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


class _Gate:
    """A runner that parks inside the job until the test lets it finish."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.saw_cancel = False

    def __call__(self, job) -> None:
        self.entered.set()
        self.release.wait(timeout=_TIMEOUT)
        # A fresh read: the cancel flag is a column another connection wrote.
        self.saw_cancel = jobs_service.cancel_requested(job.id)
        jobs_service.settle(job.id, "cancelled" if self.saw_cancel else "completed")


@override_settings(MAX_CONCURRENT_JOBS=10, MAX_CONCURRENT_JOBS_PER_USER=10)
class JobRegistryTests(MediaTransactionTestCase):
    """Registry behaviour, exercised across a real worker thread.

    The caps are lifted here so these tests are about the registry rather than
    about throttling; ConcurrencyCapTests covers the caps themselves.
    """

    def setUp(self):
        jobs_service.reset()
        self.addCleanup(jobs_service.reset)

    def test_start_returns_a_running_job_and_is_findable_by_mushaf(self):
        mushaf = bare_mushaf()
        gate = _Gate()
        job = jobs_service.start(mushaf, _params(3, 12), runner=gate)
        self.addCleanup(gate.release.set)

        self.assertTrue(gate.entered.wait(_TIMEOUT))
        job.refresh_from_db()
        self.assertEqual(job.state, "running")
        self.assertEqual(job.total, 10)
        self.assertEqual((job.page_range_start, job.page_range_end), (3, 12))
        # Found without the client having to remember the job id.
        self.assertEqual(jobs_service.latest_for(mushaf.id).id, job.id)
        self.assertEqual(jobs_service.active_for(mushaf.id).id, job.id)

    def test_second_start_for_the_same_mushaf_is_rejected(self):
        mushaf = bare_mushaf()
        gate = _Gate()
        jobs_service.start(mushaf, _params(), runner=gate)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(_TIMEOUT))

        with self.assertRaises(HttpError) as caught:
            jobs_service.start(mushaf, _params(), runner=_Gate())
        self.assertEqual(caught.exception.status_code, 409)

    def test_another_mushaf_may_run_at_the_same_time(self):
        first, second = bare_mushaf("A"), bare_mushaf("B")
        gate_a, gate_b = _Gate(), _Gate()
        jobs_service.start(first, _params(), runner=gate_a)
        jobs_service.start(second, _params(), runner=gate_b)
        self.addCleanup(gate_a.release.set)
        self.addCleanup(gate_b.release.set)

        self.assertTrue(gate_a.entered.wait(_TIMEOUT))
        self.assertTrue(gate_b.entered.wait(_TIMEOUT))
        self.assertIsNotNone(jobs_service.active_for(first.id))
        self.assertIsNotNone(jobs_service.active_for(second.id))

    def test_cancel_flags_the_job_and_the_worker_sees_the_event(self):
        mushaf = bare_mushaf()
        gate = _Gate()
        job = jobs_service.start(mushaf, _params(), runner=gate)
        self.assertTrue(gate.entered.wait(_TIMEOUT))

        returned = jobs_service.request_cancel(mushaf.id)

        self.assertEqual(returned.id, job.id)
        job.refresh_from_db()
        self.assertTrue(job.cancel_requested)
        # Still "running": a cooperative cancel settles only when the work stops.
        self.assertEqual(job.state, "running")

        gate.release.set()
        _wait_until_finished(self, job)
        self.assertTrue(gate.saw_cancel)
        self.assertEqual(job.state, "cancelled")
        self.assertIsNone(jobs_service.active_for(mushaf.id))

    def test_cancel_without_a_running_job_is_404(self):
        mushaf = bare_mushaf()
        with self.assertRaises(HttpError) as caught:
            jobs_service.request_cancel(mushaf.id)
        self.assertEqual(caught.exception.status_code, 404)

    def test_a_settled_job_stays_visible_and_a_new_one_replaces_it(self):
        mushaf = bare_mushaf()
        first = jobs_service.start(mushaf, _params(), runner=lambda job: jobs_service.settle(job.id, "completed"))
        _wait_until_finished(self, first)
        self.assertEqual(jobs_service.latest_for(mushaf.id).id, first.id)

        second = jobs_service.start(mushaf, _params(), runner=lambda job: jobs_service.settle(job.id, "completed"))
        _wait_until_finished(self, second)
        self.assertEqual(jobs_service.latest_for(mushaf.id).id, second.id)
        # Rows are kept rather than dropped: unlike the old in-memory dict, the
        # table is a run history worth having, and it grows only per run.
        self.assertIsNotNone(jobs_service.get(first.id))

    def test_a_raising_runner_settles_the_job_as_error(self):
        mushaf = bare_mushaf()

        def boom(job):
            raise RuntimeError("engine exploded")

        job = jobs_service.start(mushaf, _params(), runner=boom)
        _wait_until_finished(self, job)

        self.assertEqual(job.state, "error")
        self.assertEqual(job.error, "engine exploded")
        self.assertIsNotNone(job.ended_at)

    def test_a_runner_that_forgets_to_settle_is_not_left_running(self):
        mushaf = bare_mushaf()
        job = jobs_service.start(mushaf, _params(), runner=lambda job: None)
        _wait_until_finished(self, job)

        self.assertEqual(job.state, "error")
        self.assertIsNotNone(job.error)


class ProcessCancellationTests(MediaTestCase):
    """The service path: what a cancelled run leaves behind in the database."""

    def setUp(self):
        suras.seed_reference_data()
        jobs_service.reset()
        self.addCleanup(jobs_service.reset)

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
        jobs_service.reset()
        self.addCleanup(jobs_service.reset)

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
class ThreadedEndpointTests(MediaTransactionTestCase):
    """HTTP against a job on a real worker thread.

    Separate from ProcessEndpointTests because a running worker needs committed
    rows to look itself up — see MediaTransactionTestCase.
    """

    def setUp(self):
        jobs_service.reset()
        self.addCleanup(jobs_service.reset)
        self.user = default_user()
        self.client.force_login(self.user)

    def test_cancel_a_running_job_returns_it_flagged(self):
        mushaf = bare_mushaf()
        gate = _Gate()
        jobs_service.start(mushaf, _params(), runner=gate, inline=False)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(_TIMEOUT))

        resp = self.client.post(f"/api/mushafs/{mushaf.id}/process/cancel")

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["cancel_requested"])
        self.assertEqual(body["state"], "running")

    def test_starting_while_one_is_running_is_409(self):
        mushaf = bare_mushaf()
        gate = _Gate()
        jobs_service.start(mushaf, _params(), runner=gate, inline=False)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(_TIMEOUT))

        resp = self.client.post(
            f"/api/mushafs/{mushaf.id}/process",
            data=_params(),
            content_type="application/json",
        )

        self.assertEqual(resp.status_code, 409)


class ConcurrencyCapTests(MediaTransactionTestCase):
    """Detection is CPU-bound, so the number of runs at once has to be bounded."""

    def setUp(self):
        jobs_service.reset()
        self.addCleanup(jobs_service.reset)

    @override_settings(MAX_CONCURRENT_JOBS=1, MAX_CONCURRENT_JOBS_PER_USER=10)
    def test_the_overall_cap_is_enforced_across_mushafs(self):
        first, second = bare_mushaf("A"), bare_mushaf("B")
        gate = _Gate()
        jobs_service.start(first, _params(), runner=gate)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(_TIMEOUT))

        with self.assertRaises(HttpError) as caught:
            jobs_service.start(second, _params(), runner=_Gate())
        self.assertEqual(caught.exception.status_code, 429)

    @override_settings(MAX_CONCURRENT_JOBS=10, MAX_CONCURRENT_JOBS_PER_USER=1)
    def test_the_per_user_cap_only_blocks_that_user(self):
        alice = default_user()
        bob = make_user("bob@example.com")
        first, second, third = bare_mushaf("A", owner=alice), bare_mushaf("B", owner=alice), bare_mushaf("C", owner=bob)
        gate = _Gate()
        jobs_service.start(first, _params(), runner=gate, user=alice)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(_TIMEOUT))

        with self.assertRaises(HttpError) as caught:
            jobs_service.start(second, _params(), runner=_Gate(), user=alice)
        self.assertEqual(caught.exception.status_code, 429)

        # Bob is unaffected by Alice's usage.
        other_gate = _Gate()
        jobs_service.start(third, _params(), runner=other_gate, user=bob)
        self.addCleanup(other_gate.release.set)
        self.assertTrue(other_gate.entered.wait(_TIMEOUT))

    @override_settings(MAX_CONCURRENT_JOBS=1, MAX_CONCURRENT_JOBS_PER_USER=10)
    def test_a_settled_job_frees_its_slot(self):
        first, second = bare_mushaf("A"), bare_mushaf("B")
        jobs_service.start(first, _params(), runner=lambda job: jobs_service.settle(job.id, "completed"))
        _wait_until_finished(self, jobs_service.latest_for(first.id))

        gate = _Gate()
        jobs_service.start(second, _params(), runner=gate)
        self.addCleanup(gate.release.set)
        self.assertTrue(gate.entered.wait(_TIMEOUT))


class HeartbeatTests(MediaTestCase):
    """A job whose worker died must not block its mushaf forever."""

    def setUp(self):
        jobs_service.reset()
        self.addCleanup(jobs_service.reset)

    def _orphan(self, mushaf, *, age_seconds: int):
        """A 'running' row whose worker last reported `age_seconds` ago."""
        job = ProcessJob.objects.create(
            mushaf=mushaf,
            page_range_start=1,
            page_range_end=1,
            total=1,
            heartbeat_at=timezone.now() - timedelta(seconds=age_seconds),
        )
        return job

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_silent_job_is_settled_as_interrupted(self):
        mushaf = bare_mushaf()
        job = self._orphan(mushaf, age_seconds=600)

        self.assertIsNone(jobs_service.active_for(mushaf.id))

        job.refresh_from_db()
        self.assertEqual(job.state, "interrupted")
        self.assertIsNotNone(job.ended_at)

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_recently_seen_job_is_left_alone(self):
        """A slow page must not be mistaken for a dead worker."""
        mushaf = bare_mushaf()
        job = self._orphan(mushaf, age_seconds=5)

        self.assertIsNotNone(jobs_service.active_for(mushaf.id))

        job.refresh_from_db()
        self.assertEqual(job.state, "running")

    @override_settings(JOB_HEARTBEAT_TIMEOUT_SECONDS=60)
    def test_a_dead_job_stops_blocking_new_runs(self):
        mushaf = bare_mushaf()
        self._orphan(mushaf, age_seconds=600)

        # Would raise 409 if the corpse still counted as running.
        jobs_service.ensure_idle(mushaf.id)


def _wait_until_finished(test, job, timeout: float = _TIMEOUT) -> None:
    """Block until the worker thread has settled the job."""
    deadline = threading.Event()
    for _ in range(int(timeout * 100)):
        job.refresh_from_db()
        if jobs_service.is_finished(job) and job.ended_at is not None:
            return
        deadline.wait(0.01)
    test.fail(f"job {job.id} did not finish within {timeout}s (state={job.state})")

"""Tests for the Celery side of the job system: dispatch, the task, the worker's
start and stop.

No Redis and no worker process are involved. The publish (``apply_async``) is
replaced, or the task is run in place with ``apply``, and the worker's signals are
sent by hand. What a real worker and a real Redis do is checked by hand: see
``docs/CELERY_DOCKER_HANDOFF.md``.
"""

import socket
from datetime import timedelta
from unittest import mock

from celery.signals import worker_ready, worker_shutting_down
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from kombu.exceptions import OperationalError

from api.models import ProcessJob
from api.services.jobs.dispatch import CELERY, INLINE, THREAD, choose_job_runner, dispatch_job
from api.services.jobs.worker_events import dispatch_long_queued_jobs_again, flag_running_jobs_of_worker
from api.tasks import RUN_JOB_TASK_NAME, run_job_task
from api.tests.helpers import (
    FakeJobRunners,
    MediaTestCase,
    MediaTransactionTestCase,
    bare_mushaf,
    complete_job_at_once,
    create_job_row,
    default_user,
    delete_all_jobs,
)
from api.tests.test_process_jobs import _add_templates, _mushaf, _params
from config.celery import app as celery_app
from quran.services import suras

#: Where ``dispatch`` publishes a job. Replaced, so that no test needs Redis.
PUBLISH = "api.services.jobs.dispatch.run_job_task.apply_async"


class JobRunnerSettingTests(SimpleTestCase):
    @override_settings(PROCESS_JOBS_INLINE=False)
    def test_the_setting_picks_the_runner(self):
        with override_settings(JOB_RUNNER="celery"):
            self.assertEqual(choose_job_runner(), CELERY)
        with override_settings(JOB_RUNNER="thread"):
            self.assertEqual(choose_job_runner(), THREAD)

    @override_settings(PROCESS_JOBS_INLINE=True, JOB_RUNNER="celery")
    def test_inline_wins_over_the_setting(self):
        self.assertEqual(choose_job_runner(), INLINE)

    def test_the_celery_app_reads_its_settings_from_django(self):
        self.assertTrue(celery_app.conf.task_ignore_result)
        self.assertFalse(celery_app.conf.task_acks_late)
        self.assertEqual(celery_app.conf.worker_prefetch_multiplier, 1)
        self.assertFalse(celery_app.conf.worker_hijack_root_logger)
        self.assertEqual(list(celery_app.conf.accept_content), ["json"])
        self.assertEqual(celery_app.conf.task_serializer, "json")
        # No result backend: the job's row is the result.
        self.assertIsNone(celery_app.conf.result_backend)

    def test_the_task_is_registered_under_its_fixed_name(self):
        self.assertEqual(run_job_task.name, RUN_JOB_TASK_NAME)
        self.assertIn(RUN_JOB_TASK_NAME, celery_app.tasks)


class CeleryDispatchTests(FakeJobRunners, MediaTestCase):
    """A job handed to Celery: when it is sent, and what is sent."""

    def test_a_job_is_sent_after_the_commit_with_its_id_as_the_task_id(self):
        job = create_job_row(bare_mushaf())

        with mock.patch(PUBLISH) as publish:
            with self.captureOnCommitCallbacks() as on_commit:
                returned = dispatch_job(job, job_runner=CELERY)
            # The row is not committed yet, so a worker could not claim it: nothing is sent.
            publish.assert_not_called()
            self.assertEqual(len(on_commit), 1)
            on_commit[0]()

        publish.assert_called_once_with(args=[str(job.id)], task_id=str(job.id))
        # Nothing has run: the job waits for a worker.
        self.assertEqual(returned.state, "queued")

    def test_an_unknown_runner_is_a_configuration_error(self):
        job = create_job_row(bare_mushaf())
        with self.assertRaises(ImproperlyConfigured):
            dispatch_job(job, job_runner="carrier-pigeon")

    def test_the_task_runs_the_job_as_the_worker_that_received_it(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf)
        self.runner_of_mushaf[mushaf.id] = complete_job_at_once

        # ``apply`` runs the task here and now, as a worker would on receiving it.
        run_job_task.apply(args=[str(job.id)], task_id=str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.state, "completed")
        self.assertEqual(job.claimed_by_worker, socket.gethostname())

    def test_a_message_delivered_twice_runs_the_job_once(self):
        mushaf = bare_mushaf()
        job = create_job_row(mushaf)
        runs: list[str] = []

        def count_the_run(job):
            runs.append("ran")
            complete_job_at_once(job)

        self.runner_of_mushaf[mushaf.id] = count_the_run
        run_job_task.apply(args=[str(job.id)], task_id=str(job.id))
        run_job_task.apply(args=[str(job.id)], task_id=str(job.id))

        self.assertEqual(runs, ["ran"])


@override_settings(PROCESS_JOBS_INLINE=False, JOB_RUNNER="celery")
class CeleryEndpointTests(MediaTransactionTestCase):
    """``POST /process`` with Celery as the runner.

    A TransactionTestCase, so that the request is not inside a test's transaction:
    the job is sent during the request, as it is in real use.
    """

    def setUp(self):
        suras.seed_reference_data()
        delete_all_jobs()
        self.addCleanup(delete_all_jobs)
        self.client.force_login(default_user())
        self.mushaf = _mushaf(pages=2)
        _add_templates(self.mushaf)

    def start(self):
        return self.client.post(
            f"/api/mushafs/{self.mushaf.id}/process", data=_params(), content_type="application/json"
        )

    def test_the_request_answers_with_a_queued_job_and_sends_its_id(self):
        with mock.patch(PUBLISH) as publish:
            resp = self.start()

        self.assertEqual(resp.status_code, 202)
        body = resp.json()
        self.assertEqual((body["state"], body["run_started_at"]), ("queued", None))
        publish.assert_called_once_with(args=[body["id"]], task_id=body["id"])

    def test_redis_down_answers_503_and_settles_the_job_as_error(self):
        """The queue cannot be reached: the request is told, and no job is left
        waiting for a worker that will never hear of it."""
        with (
            mock.patch(PUBLISH, side_effect=OperationalError("Error 111 connecting to redis:6379.")),
            self.assertLogs("api.services.jobs.dispatch", level="ERROR"),
        ):
            resp = self.start()

        self.assertEqual(resp.status_code, 503)
        job = ProcessJob.objects.get(mushaf=self.mushaf)
        self.assertEqual((job.state, job.error), ("error", "The job queue could not be reached."))
        self.assertIsNotNone(job.ended_at)
        # The mushaf is free: the next attempt is not answered "already running".
        with mock.patch(PUBLISH):
            self.assertEqual(self.start().status_code, 202)


class WorkerStopTests(MediaTestCase):
    """A worker that is told to stop asks its own jobs to stop at their next page."""

    def _running(self, mushaf, worker_name: str):
        return ProcessJob.objects.create(
            mushaf=mushaf,
            state="running",
            page_range_start=1,
            page_range_end=1,
            run_started_at=timezone.now(),
            heartbeat_at=timezone.now(),
            claimed_by_worker=worker_name,
        )

    def test_the_stop_hook_flags_only_that_workers_running_jobs(self):
        mine = self._running(bare_mushaf("A"), "celery@one")
        theirs = self._running(bare_mushaf("B"), "celery@two")
        queued = create_job_row(bare_mushaf("C"))
        finished = self._running(bare_mushaf("D"), "celery@one")
        ProcessJob.objects.filter(pk=finished.pk).update(state="completed")

        with self.assertLogs("api.services.jobs.worker_events", level="WARNING"):
            self.assertEqual(flag_running_jobs_of_worker("celery@one"), 1)

        for job in (mine, theirs, queued, finished):
            job.refresh_from_db()
        self.assertTrue(mine.cancel_requested)
        self.assertEqual(mine.state, "running")  # it stops itself, at its next page
        self.assertFalse(theirs.cancel_requested)
        self.assertFalse(queued.cancel_requested)
        self.assertFalse(finished.cancel_requested)

    def test_celerys_shutdown_signal_reaches_the_hook(self):
        mine = self._running(bare_mushaf("A"), "celery@one")
        theirs = self._running(bare_mushaf("B"), "celery@two")

        # What Celery sends from the worker's main process on SIGTERM.
        with (
            mock.patch("api.services.jobs.worker_events.connections.close_all"),
            self.assertLogs("api.services.jobs.worker_events", level="WARNING"),
        ):
            worker_shutting_down.send(sender="celery@one", sig="SIGTERM", how="Warm", exitcode=0)

        mine.refresh_from_db()
        theirs.refresh_from_db()
        self.assertTrue(mine.cancel_requested)
        self.assertFalse(theirs.cancel_requested)


class WorkerStartTests(MediaTestCase):
    """A worker that starts sends the long-waiting jobs again: their message may be lost."""

    def _queued(self, mushaf, *, waited_seconds: int):
        job = create_job_row(mushaf, user=default_user())
        ProcessJob.objects.filter(pk=job.pk).update(requested_at=timezone.now() - timedelta(seconds=waited_seconds))
        return job

    def test_jobs_queued_for_over_a_minute_are_sent_again_oldest_first(self):
        older = self._queued(bare_mushaf("A"), waited_seconds=900)
        old = self._queued(bare_mushaf("B"), waited_seconds=120)
        fresh = self._queued(bare_mushaf("C"), waited_seconds=5)
        running = self._queued(bare_mushaf("D"), waited_seconds=900)
        ProcessJob.objects.filter(pk=running.pk).update(state="running")

        with mock.patch(PUBLISH) as publish:
            self.assertEqual(dispatch_long_queued_jobs_again(), 2)

        sent = [call.kwargs["task_id"] for call in publish.call_args_list]
        self.assertEqual(sent, [str(older.id), str(old.id)])
        self.assertNotIn(str(fresh.id), sent)

    def test_celerys_ready_signal_reaches_the_hook(self):
        waiting = self._queued(bare_mushaf(), waited_seconds=900)

        with mock.patch(PUBLISH) as publish, mock.patch("api.services.jobs.worker_events.connections.close_all"):
            worker_ready.send(sender=object())

        publish.assert_called_once_with(args=[str(waiting.id)], task_id=str(waiting.id))

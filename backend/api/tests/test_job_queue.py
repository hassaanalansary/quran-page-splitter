"""Tests for the queue behind a Celery worker: the three admission rules and a
job's place in the queue.

No worker runs here. The publish to Redis is replaced, so every job stays ``queued``
until a test claims it, as a worker would. What a job does on threads, where nothing
can wait, is ``test_process_jobs.ThreadModeLimitTests``.
"""

from datetime import timedelta
from unittest import mock

from django.test import override_settings
from django.utils import timezone
from ninja.errors import HttpError

from api.models import ProcessJob
from api.services.jobs.admission import (
    refuse_if_mushaf_has_active_job,
    refuse_if_queue_is_full,
    refuse_if_user_has_too_many_jobs,
)
from api.services.jobs.claiming import claim_queued_job
from api.services.jobs.dispatch import CELERY, INLINE, THREAD
from api.services.jobs.progress import record_job_outcome
from api.services.jobs.queue import count_jobs_ahead_in_queue, count_queued_jobs
from api.services.jobs.serializers import serialize_job
from api.tests.helpers import (
    FakeJobRunners,
    MediaTransactionTestCase,
    bare_mushaf,
    default_user,
    make_user,
)
from api.tests.test_process_jobs import _add_templates, _mushaf, _params
from quran.services import suras

PUBLISH = "api.services.jobs.dispatch.run_job_task.apply_async"


@override_settings(
    PROCESS_JOBS_INLINE=False, JOB_RUNNER="celery", JOB_WORKER_SLOTS=1, MAX_ACTIVE_JOBS_PER_USER=10, MAX_QUEUED_JOBS=20
)
class QueueTests(FakeJobRunners, MediaTransactionTestCase):
    """One worker slot, so every job after the first has to wait its turn."""

    def setUp(self):
        super().setUp()
        publish = mock.patch(PUBLISH)
        self.publish = publish.start()
        self.addCleanup(publish.stop)

    def queue_job(self, name: str, *, user=None, waited_seconds: int = 0):
        """Start a job as a request would. Nothing claims it, so it stays queued."""
        job = self.start_job_with_runner(bare_mushaf(name), None, user=user)
        if waited_seconds:
            ProcessJob.objects.filter(pk=job.pk).update(requested_at=timezone.now() - timedelta(seconds=waited_seconds))
            job.refresh_from_db()
        return job

    def assertRefused(self, status: int, start) -> HttpError:
        with self.assertRaises(HttpError) as caught:
            start()
        self.assertEqual(caught.exception.status_code, status)
        return caught.exception

    # -- the job waits ---------------------------------------------------------
    def test_a_job_over_the_slots_waits_in_the_queue(self):
        running = self.queue_job("A", waited_seconds=30)
        claim_queued_job(running.id, "celery@one")

        waiting = self.queue_job("B")

        # Accepted, not refused: on threads this would have been a 429.
        self.assertEqual(waiting.state, "queued")
        self.assertIsNone(waiting.run_started_at)
        self.assertEqual(self.publish.call_count, 2)

    def test_queue_position_counts_the_queued_jobs_requested_before(self):
        running = self.queue_job("A", waited_seconds=30)
        claim_queued_job(running.id, "celery@one")
        second = self.queue_job("B", waited_seconds=20)
        third = self.queue_job("C", waited_seconds=10)
        fourth = self.queue_job("D")

        # The running job holds the slot. It is not ahead of anyone in the queue.
        self.assertEqual([count_jobs_ahead_in_queue(job) for job in (second, third, fourth)], [0, 1, 2])
        self.assertEqual(count_queued_jobs(), 3)
        self.assertEqual(serialize_job(fourth)["queue_position"], 2)

    def test_a_job_moves_up_as_the_jobs_ahead_of_it_leave_the_queue(self):
        first = self.queue_job("A", waited_seconds=30)
        second = self.queue_job("B", waited_seconds=20)
        third = self.queue_job("C", waited_seconds=10)
        self.assertEqual(count_jobs_ahead_in_queue(third), 2)

        claim_queued_job(first.id, "celery@one")  # a worker takes the first
        self.assertEqual(count_jobs_ahead_in_queue(third), 1)

        record_job_outcome(second.id, "cancelled")  # the second is cancelled while it waits
        self.assertEqual(count_jobs_ahead_in_queue(third), 0)

    def test_a_job_that_is_not_queued_has_no_queue_position(self):
        job = self.queue_job("A")
        claim_queued_job(job.id, "celery@one")
        job.refresh_from_db()
        self.assertIsNone(count_jobs_ahead_in_queue(job))
        self.assertIsNone(serialize_job(job)["queue_position"])

        record_job_outcome(job.id, "completed")
        job.refresh_from_db()
        self.assertIsNone(serialize_job(job)["queue_position"])

    # -- rule 1: one active job per mushaf ------------------------------------
    def test_a_queued_job_holds_its_mushaf(self):
        job = self.queue_job("A")

        refused = self.assertRefused(409, lambda: refuse_if_mushaf_has_active_job(job.mushaf_id))

        self.assertIn("already", str(refused))

    # -- rule 2: active jobs per user ------------------------------------------
    @override_settings(MAX_ACTIVE_JOBS_PER_USER=2)
    def test_the_user_limit_counts_queued_and_running_jobs(self):
        alice, bob = default_user(), make_user("bob@example.com")
        running = self.queue_job("A", user=alice)
        claim_queued_job(running.id, "celery@one")
        self.queue_job("B", user=alice)

        # One running and one queued: Alice has her two.
        self.assertRefused(429, lambda: self.queue_job("C", user=alice))
        # Bob is not affected by what Alice has, and a job without a user is nobody's.
        self.assertEqual(self.queue_job("D", user=bob).state, "queued")
        self.assertEqual(self.queue_job("E").state, "queued")

    @override_settings(MAX_ACTIVE_JOBS_PER_USER=1)
    def test_a_settled_job_no_longer_counts_against_its_user(self):
        alice = default_user()
        first = self.queue_job("A", user=alice)
        self.assertRefused(429, lambda: refuse_if_user_has_too_many_jobs(alice))

        record_job_outcome(first.id, "completed")

        refuse_if_user_has_too_many_jobs(alice)

    # -- rule 3: jobs waiting ---------------------------------------------------
    @override_settings(MAX_QUEUED_JOBS=2)
    def test_a_full_queue_refuses_one_more_job(self):
        running = self.queue_job("A")
        claim_queued_job(running.id, "celery@one")
        self.queue_job("B")
        self.queue_job("C")

        refused = self.assertRefused(429, lambda: self.queue_job("D"))

        self.assertIn("queue is full", str(refused))
        # A job that leaves the queue makes room for one more.
        claim_queued_job(ProcessJob.objects.get(mushaf__name="B").id, "celery@two")
        self.assertEqual(self.queue_job("E").state, "queued")

    @override_settings(MAX_QUEUED_JOBS=0, MAX_ACTIVE_JOBS_PER_USER=0)
    def test_a_limit_of_zero_is_switched_off(self):
        alice = default_user()
        for name in "ABCDE":
            self.assertEqual(self.queue_job(name, user=alice).state, "queued")

    # -- where nothing can wait ---------------------------------------------------
    def test_without_a_queue_a_job_over_the_slots_is_refused(self):
        """The same settings and the same rows, but a runner with no queue behind it."""
        running = self.queue_job("A")
        claim_queued_job(running.id, "celery@one")

        refuse_if_queue_is_full(CELERY)
        for job_runner in (THREAD, INLINE):
            refused = self.assertRefused(429, lambda runner=job_runner: refuse_if_queue_is_full(runner))
            self.assertNotIn("queue is full", str(refused))


@override_settings(PROCESS_JOBS_INLINE=False, JOB_RUNNER="celery", JOB_WORKER_SLOTS=1)
class QueueEndpointTests(MediaTransactionTestCase):
    """What the browser is told about a job that waits."""

    def setUp(self):
        suras.seed_reference_data()
        self.client.force_login(default_user())
        publish = mock.patch(PUBLISH)
        publish.start()
        self.addCleanup(publish.stop)

    def start(self, mushaf):
        return self.client.post(f"/api/mushafs/{mushaf.id}/process", data=_params(), content_type="application/json")

    def mushaf_with_templates(self, name: str):
        mushaf = _mushaf(pages=2)
        mushaf.name = name
        mushaf.save(update_fields=["name"])
        _add_templates(mushaf)
        return mushaf

    @override_settings(MAX_ACTIVE_JOBS_PER_USER=5)
    def test_the_job_answers_with_its_place_in_the_queue_on_start_and_on_poll(self):
        first, second = self.mushaf_with_templates("A"), self.mushaf_with_templates("B")
        self.assertEqual(self.start(first).json()["queue_position"], 0)

        started = self.start(second)

        self.assertEqual(started.status_code, 202)
        self.assertEqual((started.json()["state"], started.json()["queue_position"]), ("queued", 1))
        polled = self.client.get(f"/api/mushafs/{second.id}/process/job").json()["job"]
        self.assertEqual((polled["state"], polled["queue_position"]), ("queued", 1))

    @override_settings(MAX_ACTIVE_JOBS_PER_USER=1)
    def test_a_second_job_of_the_same_user_is_refused_with_429(self):
        first, second = self.mushaf_with_templates("A"), self.mushaf_with_templates("B")
        self.assertEqual(self.start(first).status_code, 202)

        refused = self.start(second)

        self.assertEqual(refused.status_code, 429)
        self.assertFalse(ProcessJob.objects.filter(mushaf=second).exists())

    @override_settings(MAX_ACTIVE_JOBS_PER_USER=5, MAX_QUEUED_JOBS=1)
    def test_a_full_queue_answers_429(self):
        first, second = self.mushaf_with_templates("A"), self.mushaf_with_templates("B")
        self.assertEqual(self.start(first).status_code, 202)

        refused = self.start(second)

        self.assertEqual(refused.status_code, 429)
        self.assertIn("queue is full", refused.json()["detail"])

    def test_the_admission_rules_are_answered_before_a_bad_payload(self):
        """A mushaf with a job in the queue and no templates: "already running" is the
        more useful answer of the two."""
        mushaf = _mushaf(pages=2)
        self.assertEqual(self.start(mushaf).status_code, 400)  # no templates, nothing queued
        _add_templates(mushaf)
        self.assertEqual(self.start(mushaf).status_code, 202)
        mushaf.templates.all().delete()

        self.assertEqual(self.start(mushaf).status_code, 409)

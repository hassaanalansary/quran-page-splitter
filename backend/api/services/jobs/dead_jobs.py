"""Jobs that nothing will ever finish, found and marked ``interrupted``.

Two rules, for the two ways a job is left behind:

``mark_silent_jobs_interrupted``     a *running* job whose worker stopped reporting:
                                     a deploy, a crash, a killed process
``mark_unclaimed_jobs_interrupted``  a *queued* job that no worker picked up while
                                     there was room to run it

Without them such a job would block its mushaf for good and count against the limits
for good. The queries call ``mark_dead_jobs_interrupted`` before they answer any
question about what is working.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from api.models import ProcessJob, ProcessJobStateChoices

logger = logging.getLogger(__name__)


def mark_dead_jobs_interrupted() -> int:
    """Apply both rules. Returns how many jobs were marked."""
    return mark_silent_jobs_interrupted() + mark_unclaimed_jobs_interrupted()


def mark_silent_jobs_interrupted() -> int:
    """Mark every running job with no heartbeat inside ``JOB_HEARTBEAT_TIMEOUT_SECONDS``
    as ``interrupted``. Returns how many it marked.

    A worker records a heartbeat when it claims a job and with every progress tick
    (``progress.record_job_progress``), so silence past the timeout means the worker
    is gone. A queued job has no worker yet and is not this rule's business.
    """
    timeout_seconds = getattr(settings, "JOB_HEARTBEAT_TIMEOUT_SECONDS", 300)
    last_allowed_heartbeat = timezone.now() - timedelta(seconds=timeout_seconds)
    silent_jobs = ProcessJob.objects.filter(
        state=ProcessJobStateChoices.RUNNING, heartbeat_at__lt=last_allowed_heartbeat
    )
    count = silent_jobs.update(
        state=ProcessJobStateChoices.INTERRUPTED,
        phase="finished",
        current_page=None,
        ended_at=timezone.now(),
        error="The worker running this job stopped responding.",
    )
    if count:
        logger.warning("Marked %d job(s) interrupted: their worker stopped reporting", count)
    return count


def mark_unclaimed_jobs_interrupted() -> int:
    """Mark as ``interrupted`` every queued job that waited ``JOB_QUEUE_TIMEOUT_SECONDS``
    while a worker slot stood free the whole time. Returns how many it marked.

    Waiting alone is not an error: a job may wait hours behind long jobs. It is dead
    only when there was room to run it and nothing claimed it, which means no worker
    is listening, or the job's message was lost.

    "A slot stood free the whole time" is read from the rows: fewer jobs than there
    are slots were running at any moment of the last ``JOB_QUEUE_TIMEOUT_SECONDS``.
    That is a safe reading. Several short jobs in a row may hide a free slot, and then
    the queued job only waits a little longer before it is marked.
    """
    timeout_seconds = getattr(settings, "JOB_QUEUE_TIMEOUT_SECONDS", 600)
    worker_slots = getattr(settings, "MAX_CONCURRENT_JOBS", 2)
    now = timezone.now()
    window_start = now - timedelta(seconds=timeout_seconds)
    jobs_that_ran_in_the_window = ProcessJob.objects.filter(run_started_at__isnull=False).filter(
        Q(ended_at__isnull=True) | Q(ended_at__gt=window_start)
    )
    if worker_slots and jobs_that_ran_in_the_window.count() >= worker_slots:
        return 0
    unclaimed_jobs = ProcessJob.objects.filter(state=ProcessJobStateChoices.QUEUED, requested_at__lt=window_start)
    count = unclaimed_jobs.update(
        state=ProcessJobStateChoices.INTERRUPTED,
        phase="finished",
        current_page=None,
        ended_at=now,
        error="No worker picked this job up.",
    )
    if count:
        logger.warning("Marked %d queued job(s) interrupted: no worker picked them up", count)
    return count

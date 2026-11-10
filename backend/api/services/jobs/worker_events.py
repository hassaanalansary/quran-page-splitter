"""What happens when a Celery worker starts and when it stops.

``api.apps.ApiConfig.ready`` imports this module, which connects the two receivers
below to Celery's worker signals. Both signals fire in the worker's main process,
never in the web process.

``worker_ready``           the worker can take jobs: dispatch again the jobs that have
                           been waiting, in case their message was lost
``worker_shutting_down``   the worker was told to stop: ask its running jobs to stop
                           at their next page
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from celery.signals import worker_ready, worker_shutting_down
from django.db import connections
from django.utils import timezone

from api.models import ProcessJob, ProcessJobStateChoices
from api.services.jobs.dispatch import send_job_to_celery

logger = logging.getLogger(__name__)

#: A queued job younger than this is left alone when a worker starts: its own
#: dispatch may still be on its way to the queue.
REDISPATCH_AFTER_SECONDS = 60


@worker_ready.connect
def redispatch_waiting_jobs_when_worker_starts(sender: Any = None, **kwargs: Any) -> None:
    try:
        dispatch_long_queued_jobs_again()
    finally:
        # The worker's main process forks its children. It must not keep a
        # database connection open for them to inherit.
        connections.close_all()


@worker_shutting_down.connect
def stop_jobs_when_worker_stops(sender: Any = None, **kwargs: Any) -> None:
    """``sender`` is the name of the worker that is stopping, such as ``celery@host``."""
    try:
        flag_running_jobs_of_worker(str(sender))
    finally:
        connections.close_all()


def dispatch_long_queued_jobs_again() -> int:
    """Send every job that has been queued for over a minute to the queue again, oldest
    first. Returns how many were sent.

    A message can be lost: Redis restarted without its data, or a worker died holding
    messages it had not started. The row is still ``queued`` and nothing would ever
    run it. Sending a job twice is harmless, because only one claim can win
    (``claiming.claim_queued_job``).
    """
    waiting_since = timezone.now() - timedelta(seconds=REDISPATCH_AFTER_SECONDS)
    waiting_jobs = ProcessJob.objects.filter(
        state=ProcessJobStateChoices.QUEUED, requested_at__lt=waiting_since
    ).order_by("requested_at")
    job_ids = list(waiting_jobs.values_list("id", flat=True))
    for job_id in job_ids:
        send_job_to_celery(job_id)
    if job_ids:
        logger.info("Dispatched %d waiting job(s) again", len(job_ids))
    return len(job_ids)


def flag_running_jobs_of_worker(worker_name: str) -> int:
    """Set the cancel flag on every job that is running on ``worker_name``. Returns how
    many were flagged.

    A worker that is told to stop (a deploy, a restart, a saved file in development)
    waits for its jobs. With the flag set they stop at their next page and settle
    ``cancelled`` with ``stopped_on_page``, from where the run can be resumed. Without
    it the worker would wait out a whole-mushaf run, or be killed in the middle of one.

    A crash gives no such chance: out of memory, a segfault. That job ends as
    ``interrupted``, through ``dead_jobs.mark_silent_jobs_interrupted``.
    """
    flagged = ProcessJob.objects.filter(state=ProcessJobStateChoices.RUNNING, claimed_by_worker=worker_name).update(
        cancel_requested=True
    )
    if flagged:
        logger.warning("Worker %s is stopping: asked %d running job(s) to stop", worker_name, flagged)
    return flagged

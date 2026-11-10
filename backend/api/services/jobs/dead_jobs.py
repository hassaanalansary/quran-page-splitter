"""Jobs whose worker is gone: found by their silence and marked ``interrupted``.

A worker records a heartbeat with every progress tick (``progress.record_job_progress``).
A job that stays silent past the timeout has lost its worker to a deploy, a crash or a
killed process. Without this rule that job would block its mushaf for good and count
against the limits for good.

The queries call this before they answer any question about what is running.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from api.models import ProcessJob, ProcessJobStateChoices
from api.services.jobs.states import TERMINAL_STATES

logger = logging.getLogger(__name__)


def mark_silent_jobs_interrupted() -> int:
    """Mark every unfinished job with no heartbeat inside the timeout as ``interrupted``.
    Returns how many it marked."""
    timeout_seconds = getattr(settings, "JOB_HEARTBEAT_TIMEOUT_SECONDS", 300)
    last_allowed_heartbeat = timezone.now() - timedelta(seconds=timeout_seconds)
    silent_jobs = ProcessJob.objects.filter(heartbeat_at__lt=last_allowed_heartbeat).exclude(state__in=TERMINAL_STATES)
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

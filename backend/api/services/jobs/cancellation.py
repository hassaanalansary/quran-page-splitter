"""Cancelling a job: at once while it is queued, through a flag once it is running.

A queued job has done nothing yet, so it is settled as ``cancelled`` directly. A
running job is cancelled cooperatively, because there is no safe way to kill a worker
in the middle of a write: the request sets a flag, and the worker reads it between its
units of work. Detection reads it between pages and calibration between lines. The
cost is a delay of at most one unit. The gain is that a cancelled job settles cleanly,
with everything it finished still stored.

The flag is a column and not a ``threading.Event``, because the worker is in another
thread or another process, where a signal held in memory would never arrive.
"""

from __future__ import annotations

import logging
import uuid

from django.utils import timezone
from ninja.errors import HttpError

from api import i18n
from api.models import ProcessJob, ProcessJobStateChoices
from api.services.jobs.queries import Kinds, find_active_job_of_mushaf

logger = logging.getLogger(__name__)


def request_job_cancellation(
    mushaf_id: uuid.UUID, *, kind: Kinds = None, message: str = "no_active_process"
) -> ProcessJob:
    """Cancel the mushaf's queued job, or ask its running job to stop at its next page
    or line. 404, with the ``message`` key, when the mushaf has no such job of that ``kind``."""
    job = find_active_job_of_mushaf(mushaf_id, kind=kind)
    if job is None:
        raise HttpError(404, i18n.t(message))
    if not cancel_job_before_it_starts(job.id):
        ProcessJob.objects.filter(pk=job.pk).update(cancel_requested=True)
    job.refresh_from_db()
    logger.info("Cancel requested for job %s (mushaf %s), now %s", job.id, mushaf_id, job.state)
    return job


def cancel_job_before_it_starts(job_id: uuid.UUID) -> bool:
    """Settle the job as ``cancelled`` if it is still queued. Returns whether it was.

    One conditional ``UPDATE … WHERE state = 'queued'``, the same condition as the
    worker's claim (``claiming.claim_queued_job``). Whichever of the two reaches the
    row first wins, and the other changes nothing: a job is never both cancelled
    here and started there.
    """
    cancelled = ProcessJob.objects.filter(pk=job_id, state=ProcessJobStateChoices.QUEUED).update(
        state=ProcessJobStateChoices.CANCELLED,
        phase="finished",
        cancel_requested=True,
        ended_at=timezone.now(),
    )
    return bool(cancelled)


def is_job_cancellation_requested(job_id: uuid.UUID) -> bool:
    """The cancel flag, read fresh from the row. It is what the worker asks between pages.

    It is never cached on a model instance: the point is to see a write that another
    request made, quite possibly in another process.
    """
    return bool(ProcessJob.objects.filter(pk=job_id).values_list("cancel_requested", flat=True).first())

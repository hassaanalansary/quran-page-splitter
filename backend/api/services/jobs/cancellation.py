"""The cancel flag: a request sets it, the worker reads it between its units of work.

Cancelling is cooperative, because there is no safe way to kill a thread in the
middle of a write. Detection reads the flag between pages and calibration between
lines. The cost is a delay of at most one unit. The gain is that a cancelled job
settles cleanly, with everything it finished still stored.

The flag is a column and not a ``threading.Event``, because the worker may be in
another process, where a signal held in memory would never arrive.
"""

from __future__ import annotations

import logging
import uuid

from ninja.errors import HttpError

from api import i18n
from api.models import ProcessJob
from api.services.jobs.queries import Kinds, find_active_job_of_mushaf

logger = logging.getLogger(__name__)


def request_job_cancellation(
    mushaf_id: uuid.UUID, *, kind: Kinds = None, message: str = "no_active_process"
) -> ProcessJob:
    """Ask the mushaf's working job to stop at its next page or line. 404, with the
    ``message`` key, when the mushaf has no working job of that ``kind``."""
    job = find_active_job_of_mushaf(mushaf_id, kind=kind)
    if job is None:
        raise HttpError(404, i18n.t(message))
    ProcessJob.objects.filter(pk=job.pk).update(cancel_requested=True)
    job.refresh_from_db()
    logger.info("Cancel requested for job %s (mushaf %s)", job.id, mushaf_id)
    return job


def is_job_cancellation_requested(job_id: uuid.UUID) -> bool:
    """The cancel flag, read fresh from the row. It is what the worker asks between pages.

    It is never cached on a model instance: the point is to see a write that another
    request made, quite possibly in another process.
    """
    return bool(ProcessJob.objects.filter(pk=job_id).values_list("cancel_requested", flat=True).first())

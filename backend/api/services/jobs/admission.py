"""The rules that refuse a job before it exists.

Every ``start_…_job`` in ``kinds/`` calls all three before it creates the row. Once the
row exists the response has gone, and a refusal could only show up as a failed job.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import ProcessJob
from api.services.jobs.queries import find_active_job_of_mushaf
from api.services.jobs.states import TERMINAL_STATES


def refuse_if_mushaf_has_active_job(mushaf_id: uuid.UUID) -> None:
    """409 if this mushaf already has a job that is not finished, **of any kind**.

    Two detection jobs would race over the same ``Page`` rows and the same sura and
    aya carry-over. A detection job beside a calibration job is worse than a race:
    ``write_coords_to_page`` deletes the page's ``Line`` rows while calibration is
    reading them and taking their snapshots. So a mushaf has one job at a time,
    whatever the two kinds are.
    """
    if find_active_job_of_mushaf(mushaf_id) is not None:
        raise HttpError(409, i18n.t("process_already_running"))


def refuse_if_user_has_too_many_jobs(user: User | None) -> None:
    """429 if this user already has as many unfinished jobs as one user may have
    (``MAX_CONCURRENT_JOBS_PER_USER``). A job with no user, such as one a management
    command starts, is not counted against anyone."""
    limit = getattr(settings, "MAX_CONCURRENT_JOBS_PER_USER", 1)
    if user is None or not limit:
        return
    if ProcessJob.objects.exclude(state__in=TERMINAL_STATES).filter(started_by=user).count() >= limit:
        raise HttpError(429, i18n.t("too_many_jobs_for_user", count=limit))


def refuse_if_queue_is_full() -> None:
    """429 if the server is already running as many jobs as it has room for
    (``MAX_CONCURRENT_JOBS``). No job waits for a turn: one that cannot start now is refused.

    The engines are CPU-bound, so more jobs at once does not mean more work done. It
    means every job gets slower. The jobs are counted in the table, because the limit
    has to hold across every web process.
    """
    limit = getattr(settings, "MAX_CONCURRENT_JOBS", 2)
    if limit and ProcessJob.objects.exclude(state__in=TERMINAL_STATES).count() >= limit:
        raise HttpError(429, i18n.t("too_many_jobs"))

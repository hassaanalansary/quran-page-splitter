"""The rules that refuse a job before it exists.

Every ``start_…_job`` in ``kinds/`` calls all three, in this order, before anything
else. Once the row exists the response has gone, and a refusal could only show up as
a failed job.

==========================  ============================  ==============
Rule                        Setting                       Over the limit
==========================  ============================  ==============
One active job per mushaf   none                          409
Active jobs per user        ``MAX_ACTIVE_JOBS_PER_USER``  429
Jobs waiting in the queue   ``MAX_QUEUED_JOBS``           429
==========================  ============================  ==============

"Active" is queued or running. Jobs *running* at once are not refused at all: the
worker runs ``JOB_WORKER_SLOTS`` of them and the rest wait their turn. Only where
nothing can wait (a thread, or the request itself) is a job refused for want of a slot.

A limit set to 0 is switched off.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import ProcessJob
from api.services.jobs.dispatch import CELERY, choose_job_runner
from api.services.jobs.queries import find_active_job_of_mushaf
from api.services.jobs.queue import count_queued_jobs
from api.services.jobs.states import TERMINAL_STATES


def refuse_if_mushaf_has_active_job(mushaf_id: uuid.UUID) -> None:
    """409 if this mushaf already has a job that is queued or running, **of any kind**.

    Two detection jobs would race over the same ``Page`` rows and the same sura and
    aya carry-over. A detection job beside a calibration job is worse than a race:
    ``write_coords_to_page`` deletes the page's ``Line`` rows while calibration is
    reading them and taking their snapshots. So a mushaf has one job at a time,
    whatever the two kinds are.
    """
    if find_active_job_of_mushaf(mushaf_id) is not None:
        raise HttpError(409, i18n.t("process_already_running"))


def refuse_if_user_has_too_many_jobs(user: User | None) -> None:
    """429 if this user already has ``MAX_ACTIVE_JOBS_PER_USER`` jobs queued or running.

    One user must not fill the queue. A job with no user, such as one a management
    command starts, is not counted against anyone.
    """
    limit = settings.MAX_ACTIVE_JOBS_PER_USER
    if user is None or not limit:
        return
    if ProcessJob.objects.exclude(state__in=TERMINAL_STATES).filter(requested_by=user).count() >= limit:
        raise HttpError(429, i18n.t("too_many_jobs_for_user", count=limit))


def refuse_if_queue_is_full(job_runner: str | None = None) -> None:
    """429 if one more job would have nowhere to wait.

    Behind a Celery worker, ``MAX_QUEUED_JOBS`` jobs may wait for a slot. A thread or
    the request itself starts a job at once, so there the queue holds nothing: with
    every one of the ``JOB_WORKER_SLOTS`` taken, the job is refused.

    ``job_runner`` is the runner this job will be dispatched to. Left out, the
    settings decide, as they do in ``dispatch.dispatch_job``.

    The engines are CPU-bound, so more jobs at once does not mean more work done. It
    means every job gets slower. The jobs are counted in the table, because the
    limits have to hold across every web process.
    """
    if (job_runner or choose_job_runner()) == CELERY:
        limit = settings.MAX_QUEUED_JOBS
        if limit and count_queued_jobs() >= limit:
            raise HttpError(429, i18n.t("job_queue_full"))
        return
    slots = settings.JOB_WORKER_SLOTS
    if slots and ProcessJob.objects.exclude(state__in=TERMINAL_STATES).count() >= slots:
        raise HttpError(429, i18n.t("too_many_jobs"))

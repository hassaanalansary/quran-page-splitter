"""Finding jobs: for the polling endpoints, for the admission rules, and for a worker
that asks about its own job.

The two "of a mushaf" queries first mark dead jobs (``dead_jobs``), so a job whose
worker died, or that no worker ever claimed, never answers as working.
"""

from __future__ import annotations

import uuid

from django.db.models import QuerySet

from api.models import ProcessJob
from api.services.jobs.dead_jobs import mark_dead_jobs_interrupted
from api.services.jobs.states import TERMINAL_STATES

#: One kind, or the several kinds one screen polls together (calibration's page job
#: and batch job), or None for every kind.
Kinds = str | tuple[str, ...] | None


def find_job_by_id(job_id: uuid.UUID) -> ProcessJob | None:
    return ProcessJob.objects.filter(id=job_id).first()


def find_latest_job_of_mushaf(mushaf_id: uuid.UUID, *, kind: Kinds = None) -> ProcessJob | None:
    """The mushaf's most recent job: queued, running or settled. None if it never had one.

    Each poller passes its own ``kind``. A calibration job shown in the processing
    panel would read as a detection run that lost its page counter.
    """
    mark_dead_jobs_interrupted()
    jobs = narrow_jobs_to_kind(ProcessJob.objects.filter(mushaf_id=mushaf_id), kind)
    return jobs.order_by("-requested_at").first()


def find_active_job_of_mushaf(mushaf_id: uuid.UUID, *, kind: Kinds = None) -> ProcessJob | None:
    """The mushaf's job that is queued or running, or None.

    A caller that guards against two jobs on one mushaf passes no ``kind``, on purpose:
    see ``admission.refuse_if_mushaf_has_active_job``.
    """
    mark_dead_jobs_interrupted()
    jobs = narrow_jobs_to_kind(ProcessJob.objects.filter(mushaf_id=mushaf_id).exclude(state__in=TERMINAL_STATES), kind)
    return jobs.order_by("-requested_at").first()


def is_job_settled(job_id: uuid.UUID) -> bool:
    """Whether the job's row is in a final state, read fresh.

    A long job asks this about itself between its units of work. A unit that ran past
    the heartbeat timeout gets the row marked ``interrupted`` under the worker. The
    row then no longer holds the mushaf, a second job may have started, and carrying
    on would race it.
    """
    return ProcessJob.objects.filter(pk=job_id, state__in=TERMINAL_STATES).exists()


def narrow_jobs_to_kind(jobs: QuerySet[ProcessJob], kind: Kinds) -> QuerySet[ProcessJob]:
    if kind is None:
        return jobs
    return jobs.filter(kind=kind) if isinstance(kind, str) else jobs.filter(kind__in=kind)

"""The library rebuild job: the stored fingerprint set regrouped from the confirmed pages.

::

    POST …/calibration/library/rebuild ─┐
    applying a new LIMIT or comparison ─┼▶ start_library_rebuild_job ─▶ dispatch
    manage.py rebuild_library ──────────┘   ─▶ run_library_rebuild_job ─▶ fingerprint_rebuild.rebuild_fingerprint_set

A background job because a regroup reads every confirmed blob (4 s at 27 pages, a minute
or more by the end of a mushaf), and it must not hold a request, or another user's,
that long. The old set serves until the new one commits.

The row's ``params`` are empty: the set is regrouped at the settings in force when it runs.
"""

from __future__ import annotations

from accounts.models import User
from api.models import Mushaf, ProcessJob, ProcessJobKindChoices, ProcessJobStateChoices
from api.services.fingerprint_rebuild import rebuild_fingerprint_set
from api.services.jobs.admission import (
    refuse_if_mushaf_has_active_job,
    refuse_if_queue_is_full,
    refuse_if_user_has_too_many_jobs,
)
from api.services.jobs.creation import create_queued_job
from api.services.jobs.dispatch import dispatch_job
from api.services.jobs.progress import record_job_outcome, record_job_progress


def start_library_rebuild_job(mushaf: Mushaf, *, user: User | None, job_runner: str | None = None) -> ProcessJob:
    """Start regrouping the mushaf's fingerprint set and return its job. Refused, like
    every job, while another job holds the mushaf."""
    refuse_if_mushaf_has_active_job(mushaf.id)
    refuse_if_user_has_too_many_jobs(user)
    refuse_if_queue_is_full(job_runner)
    job = create_queued_job(
        kind=ProcessJobKindChoices.LIBRARY_REBUILD,
        mushaf=mushaf,
        requested_by=user,
        params={},
        first_page=0,
        last_page=0,
        total=1,
    )
    return dispatch_job(job, job_runner=job_runner)


def run_library_rebuild_job(job: ProcessJob) -> None:
    """Regroup the set, and settle the job ``completed``. It cannot stop halfway: a
    cancel that arrives while it runs is ignored, and the set it commits is whole."""
    rebuild_fingerprint_set(job.mushaf, progress=lambda phase: record_job_progress(job.id, phase=phase))
    record_job_outcome(job.id, ProcessJobStateChoices.COMPLETED, pages_saved=0)

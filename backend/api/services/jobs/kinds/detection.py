"""The detection job: the line engine over a range of pages.

::

    POST /process ─▶ start_detection_job ─▶ dispatch ─▶ run_detection_job ─▶ processing.process

The engine work itself is ``api.services.processing``, which knows nothing about jobs.
This module binds it to a job row: the inputs come from the row, progress and the
outcome go to the row, and the cancel flag is read from it.

The row's ``params`` is the request body of ``POST /process``, whole: the page range
and the engine's settings.
"""

from __future__ import annotations

import uuid
from typing import Any

from accounts.models import User
from api.models import Mushaf, ProcessJob, ProcessJobKindChoices
from api.services import processing
from api.services.jobs.admission import (
    refuse_if_mushaf_has_active_job,
    refuse_if_queue_is_full,
    refuse_if_user_has_too_many_jobs,
)
from api.services.jobs.cancellation import is_job_cancellation_requested
from api.services.jobs.creation import create_queued_job
from api.services.jobs.dispatch import dispatch_job
from api.services.jobs.progress import record_job_outcome, record_job_progress


def start_detection_job(
    mushaf: Mushaf,
    detection_settings: dict[str, Any],
    *,
    user: User | None = None,
    job_runner: str | None = None,
) -> ProcessJob:
    """Start detection over the page range in ``detection_settings`` and return its job.

    ``detection_settings`` is the request body of ``POST /process``: the page range
    and the engine's settings. Everything that can be refused is refused here, while
    the caller can still be told. The admission rules come before a bad payload:
    "a job is already running" is the more useful answer when both are true.

    ``job_runner`` overrides the ``JOB_RUNNER`` setting for this one job. The debug
    commands pass it.
    """
    first_page = int(detection_settings["page_range_start"])
    last_page = int(detection_settings["page_range_end"])
    refuse_if_mushaf_has_active_job(mushaf.id)
    refuse_if_user_has_too_many_jobs(user)
    refuse_if_queue_is_full(job_runner)
    processing.preflight(mushaf, first_page, last_page)
    job = create_queued_job(
        kind=ProcessJobKindChoices.DETECTION,
        mushaf=mushaf,
        requested_by=user,
        params=detection_settings,
        first_page=first_page,
        last_page=last_page,
        total=max(0, last_page - first_page + 1),
    )
    return dispatch_job(job, job_runner=job_runner)


def run_detection_job(job: ProcessJob) -> None:
    """Run the line engine over the job's mushaf with the job's ``params``, and settle
    the job with the run's outcome."""

    def record_detection_progress(phase: str, current_page: int | None, pages_saved: int) -> None:
        record_job_progress(job.id, phase=phase, current_page=current_page, pages_saved=pages_saved)

    def record_run_started(run_id: uuid.UUID, log_url: str) -> None:
        # Recorded before any page is processed, so that a run that dies half way
        # can still be traced to its row and its log.
        record_job_progress(job.id, run_id=run_id, log_url=log_url or "")

    result = processing.process(
        job.mushaf,
        **job.params,
        should_cancel=lambda: is_job_cancellation_requested(job.id),
        on_progress=record_detection_progress,
        on_run_started=record_run_started,
    )
    record_job_outcome(
        job.id,
        result["status"],
        run_id=result["run_id"],
        log_url=result["log_url"] or "",
        pages_saved=result["pages_saved"],
        stopped_on_page=result["stopped_on_page"],
        abort_info=result["abort_info"],
        end_sura=result["end_sura"],
        end_aya=result["end_aya"],
    )

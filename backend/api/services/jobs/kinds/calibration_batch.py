"""The calibration batch job: the word engine over a range of pages, one after another.

::

    POST …/calibration/batch ─▶ start_calibration_batch_job ─▶ dispatch
                                ─▶ run_calibration_batch_job
                                   └ for each page: decide_batch_page_when_reached
                                                    process_batch_page ─▶ calibration.process_page

What a batch does to each page, and why, is decided in ``api.services.calibration_batch``,
which knows nothing about jobs. The job counts pages. Its ``report`` column says what
happened to every page so far, so a poll can show it while the batch works.

The row's ``params``: ``refresh``, whether drafts that are still current are processed
again. The range is the row's own page range.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import Mushaf, ProcessJob, ProcessJobKindChoices, ProcessJobStateChoices
from api.services import calibration_batch
from api.services.calibration import process_page
from api.services.calibration_batch import PROCESS, decide_batch_page_when_reached
from api.services.jobs.admission import (
    refuse_if_mushaf_has_active_job,
    refuse_if_queue_is_full,
    refuse_if_user_has_too_many_jobs,
)
from api.services.jobs.cancellation import is_job_cancellation_requested
from api.services.jobs.creation import create_queued_job
from api.services.jobs.dispatch import dispatch_job
from api.services.jobs.progress import record_job_outcome, record_job_progress
from api.services.jobs.queries import is_job_settled

logger = logging.getLogger(__name__)

Doc = dict[str, Any]


def start_calibration_batch_job(
    mushaf: Mushaf,
    first: int,
    last: int,
    *,
    refresh: bool = False,
    user: User | None = None,
    job_runner: str | None = None,
) -> ProcessJob:
    """Start processing pages ``first``..``last`` as one job and return it. Refuses a
    range in which there is nothing it could process."""
    planned = calibration_batch.plan(mushaf, first, last, refresh=refresh)
    if not planned["process"] and not planned["drafted"]:
        raise HttpError(422, i18n.t("calibration_batch_nothing", first=first, last=last))
    refuse_if_mushaf_has_active_job(mushaf.id)
    refuse_if_queue_is_full()
    refuse_if_user_has_too_many_jobs(user)
    job = create_queued_job(
        kind=ProcessJobKindChoices.CALIBRATION_BATCH,
        mushaf=mushaf,
        requested_by=user,
        params={"refresh": refresh},
        first_page=first,
        last_page=last,
        total=last - first + 1,
        report={
            "first": first,
            "last": last,
            "refresh": refresh,
            "planned": planned["process"],
            "processed": [],
            "skipped": {},
            "failed": [],
            "busy_seconds": 0.0,
        },
    )
    return dispatch_job(job, job_runner=job_runner)


def run_calibration_batch_job(job: ProcessJob) -> None:
    """Walk the job's page range, as the user who asked for it, and settle the job:
    ``completed`` at the end of the range, ``cancelled`` at the page where a cancel
    reached it. That page is ``stopped_on_page``: the first page the batch did not
    finish."""
    mushaf = job.mushaf
    refresh = bool(job.params["refresh"])
    report: Doc = dict(job.report or {})
    cancelled = False
    for page_number in range(job.page_range_start, job.page_range_end + 1):
        # Settled under it means another job may hold the mushaf now: stop quietly.
        if is_job_settled(job.id):
            return
        if is_job_cancellation_requested(job.id):
            cancelled = True
            break
        reason, revision = decide_batch_page_when_reached(mushaf, page_number, refresh=refresh)
        if reason not in PROCESS:
            report["skipped"].setdefault(reason, []).append(page_number)
            record_job_progress(job.id, current_page=page_number, report=report)
            continue
        if not process_batch_page(job, page_number, revision, reason, report):
            cancelled = True
            break
    record_job_outcome(
        job.id,
        ProcessJobStateChoices.CANCELLED if cancelled else ProcessJobStateChoices.COMPLETED,
        pages_saved=len(report["processed"]),
        report=report,
        stopped_on_page=page_number if cancelled else None,
    )


def process_batch_page(job: ProcessJob, page_number: int, expected_revision: int, reason: str, report: Doc) -> bool:
    """Process one page of the batch and write what happened into ``report``.

    Returns False only when a cancel stopped the page before it was stored. A page
    that fails is written into ``report["failed"]`` and the batch goes on: one page
    must not cost the rest of the range.
    """
    record_job_progress(job.id, current_page=page_number, phase="detecting", lines_done=0, report=report)
    began = time.monotonic()
    try:
        stored = process_page(
            job.mushaf,
            page_number,
            expected_revision=expected_revision,
            user=job.requested_by,
            progress=lambda lines_done: record_job_progress(job.id, lines_done=lines_done),
            cancelled=lambda: is_job_cancellation_requested(job.id),
        )
    except HttpError as refused:
        # Changed between deciding and storing: edited, re-reviewed, renumbered.
        report["failed"].append({"page": page_number, "error": str(refused)})
        record_job_progress(job.id, report=report)
        return True
    except Exception as failure:
        logger.exception("Calibration batch %s: page %s failed", job.id, page_number)
        report["failed"].append({"page": page_number, "error": str(failure) or failure.__class__.__name__})
        record_job_progress(job.id, report=report)
        return True
    if not stored:
        return False
    report["processed"].append(page_number)
    report["busy_seconds"] = round(report.get("busy_seconds", 0.0) + time.monotonic() - began, 1)
    logger.info("Calibration batch %s: page %s processed (%s)", job.id, page_number, reason)
    record_job_progress(job.id, pages_saved=len(report["processed"]), report=report)
    return True

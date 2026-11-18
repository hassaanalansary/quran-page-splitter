"""The calibration page job: the word engine over one page, for review.

::

    POST …/calibration/process ─▶ start_calibration_page_job ─▶ dispatch
                                  ─▶ run_calibration_page_job ─▶ calibration.process_page

The work itself is ``api.services.calibration.process_page``, which knows nothing
about jobs. The job counts the lines of the aya span that covers the page.

The row's ``params``: ``page``, the page to process, and ``expected_revision``, the
draft revision the request saw. ``process_page`` refuses to store over a newer one.
"""

from __future__ import annotations

from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import Mushaf, ProcessJob, ProcessJobKindChoices, ProcessJobStateChoices
from api.services import word_runs
from api.services.calibration import (
    are_context_lines_current,
    are_line_snapshots_current,
    find_aya_span_of_page,
    find_review_of_page,
    process_page,
)
from api.services.jobs.admission import (
    refuse_if_mushaf_has_active_job,
    refuse_if_queue_is_full,
    refuse_if_user_has_too_many_jobs,
)
from api.services.jobs.cancellation import is_job_cancellation_requested
from api.services.jobs.creation import create_queued_job
from api.services.jobs.dispatch import dispatch_job
from api.services.jobs.progress import record_job_outcome, record_job_progress


def start_calibration_page_job(
    mushaf: Mushaf, page: int, *, user: User | None, job_runner: str | None = None
) -> ProcessJob:
    """Start processing one page for review and return its job. Refuses what it can up front.

    A page already processed from the sources it still has is refused: there is
    nothing new to read. A page whose sources changed since may be processed again.
    Its sources are its own lines and the neighbouring lines its ayat cross onto, and
    they change when a page is processed again, reviewed again, or erased on. Every
    decision on a line that did not change is kept (``calibration._carry_decisions``),
    and the old revisions stay in the history.
    """
    refuse_if_mushaf_has_active_job(mushaf.id)
    refuse_if_user_has_too_many_jobs(user)
    refuse_if_queue_is_full(job_runner)
    span_start, span_end = find_aya_span_of_page(mushaf, page)
    plan = word_runs.preflight(mushaf, span_start, span_end)
    review = find_review_of_page(mushaf, page)
    if (
        review is not None
        and review.payload.get("lines")
        and are_line_snapshots_current(mushaf, review.payload["lines"])
        and are_context_lines_current(mushaf, review.payload.get("context", []))
    ):
        raise HttpError(409, i18n.t("calibration_already_processed", page=page))
    job = create_queued_job(
        kind=ProcessJobKindChoices.CALIBRATION,
        mushaf=mushaf,
        requested_by=user,
        params={"page": page, "expected_revision": review.revision if review else 0},
        first_page=plan.first_page,
        last_page=plan.last_page,
        total=plan.total_lines,
        current_page=page,
        lines_done=0,
        aya_span=(plan.start, plan.end),
    )
    return dispatch_job(job, job_runner=job_runner)


def run_calibration_page_job(job: ProcessJob) -> None:
    """Process the page named in the job's ``params``, as the user who asked for it,
    and settle the job: ``completed`` when the draft was stored, ``cancelled`` when a
    cancel arrived before anything was. A cancelled job names the page in
    ``stopped_on_page``: nothing of it was stored."""
    page = int(job.params["page"])
    stored = process_page(
        job.mushaf,
        page,
        expected_revision=int(job.params["expected_revision"]),
        user=job.requested_by,
        progress=lambda lines_done: record_job_progress(job.id, phase="detecting", lines_done=lines_done),
        cancelled=lambda: is_job_cancellation_requested(job.id),
    )
    record_job_outcome(
        job.id,
        ProcessJobStateChoices.COMPLETED if stored else ProcessJobStateChoices.CANCELLED,
        pages_saved=1 if stored else 0,
        stopped_on_page=None if stored else page,
    )

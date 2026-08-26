"""Registry for long-running processing work, so the HTTP request doesn't wait.

Processing a page range takes seconds per page — minutes to hours for a whole
mushaf. Holding an HTTP request open for that is what forced the old design:
the frontend sliced the range into 50-page requests just to see progress, and a
run could not be stopped because nothing was listening for a stop.

Here the request only *starts* the work. A worker thread owns the run; the
``ProcessJob`` row is the shared state both sides see::

    POST   /process         -> 202, creates the job, returns it immediately
    GET    /process/job     -> poll it (progress, phase, final outcome)
    POST   /process/cancel  -> set the job's cancel flag

Cancellation is cooperative — the flag is polled by the pipeline between pages
(see core/pipeline.py) — because there is no safe way to kill a thread mid-write.
The cost is latency of at most one page; the benefit is that a cancelled run
settles cleanly with everything it finished already persisted.

**State lives in the database, not in this module.** It used to be a dict of
dataclasses, which meant a restart forgot every running job and a poll served by
a second worker process answered "no job" for a run that was very much alive.
A row is visible to every process, so:

* progress polls work no matter which worker answers them;
* a cancel raised in one process is seen by a worker in another;
* a job whose worker died stops looking alive — see ``_settle_dead_jobs``.

What a row cannot do is survive its *worker*: the thread still lives inside one
process, so a deploy interrupts in-flight runs. They are settled as
``interrupted`` rather than left running forever, which is the honest limit of
this design without a task broker.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from django.conf import settings
from django.db import connections
from django.utils import timezone
from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import Mushaf, ProcessJob, ProcessJobStateChoices
from api.services import processing as processing_service

logger = logging.getLogger(__name__)

#: States a job can settle in. Anything else means it is still working.
TERMINAL_STATES = frozenset(
    {
        ProcessJobStateChoices.COMPLETED,
        ProcessJobStateChoices.ABORTED_LINE_DETECTION,
        ProcessJobStateChoices.CANCELLED,
        ProcessJobStateChoices.ERROR,
        ProcessJobStateChoices.INTERRUPTED,
    }
)


def _heartbeat_cutoff() -> datetime:
    seconds = getattr(settings, "JOB_HEARTBEAT_TIMEOUT_SECONDS", 300)
    return timezone.now() - timedelta(seconds=seconds)


def to_dict(job: ProcessJob) -> dict:
    """Serializable snapshot, in the shape the frontend already expects."""
    return {
        "id": job.id,
        "mushaf_id": job.mushaf_id,
        "state": job.state,
        "phase": job.phase,
        "page_range_start": job.page_range_start,
        "page_range_end": job.page_range_end,
        "total": job.total,
        "pages_saved": job.pages_saved,
        "current_page": job.current_page,
        "cancel_requested": job.cancel_requested,
        "started_at": job.started_at,
        "ended_at": job.ended_at,
        "run_id": job.run_id,
        "log_url": job.log_url or None,
        "stopped_on_page": job.stopped_on_page,
        "abort_info": job.abort_info,
        "error": job.error or None,
        "end_sura": job.end_sura,
        "end_aya": job.end_aya,
    }


def is_finished(job: ProcessJob) -> bool:
    return job.state in TERMINAL_STATES


# ----------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------


def _settle_dead_jobs() -> int:
    """Mark jobs whose worker has gone quiet as ``interrupted``.

    Called before any question about what is running. A worker updates its
    heartbeat on every progress tick, so silence beyond the timeout means the
    process holding it is gone — otherwise a crashed run would block its mushaf
    forever and count against the concurrency caps for good.
    """
    stale = ProcessJob.objects.filter(heartbeat_at__lt=_heartbeat_cutoff()).exclude(state__in=TERMINAL_STATES)
    count = stale.update(
        state=ProcessJobStateChoices.INTERRUPTED,
        phase="finished",
        current_page=None,
        ended_at=timezone.now(),
        error="The worker running this job stopped responding.",
    )
    if count:
        logger.warning("Settled %d job(s) whose worker stopped reporting", count)
    return count


def get(job_id: uuid.UUID) -> ProcessJob | None:
    return ProcessJob.objects.filter(id=job_id).first()


def latest_for(mushaf_id: uuid.UUID) -> ProcessJob | None:
    """The mushaf's most recent job, running or settled (None if never run)."""
    _settle_dead_jobs()
    return ProcessJob.objects.filter(mushaf_id=mushaf_id).order_by("-started_at").first()


def active_for(mushaf_id: uuid.UUID) -> ProcessJob | None:
    """The mushaf's job if it is still working, else None."""
    _settle_dead_jobs()
    return (
        ProcessJob.objects.filter(mushaf_id=mushaf_id)
        .exclude(state__in=TERMINAL_STATES)
        .order_by("-started_at")
        .first()
    )


def ensure_idle(mushaf_id: uuid.UUID) -> None:
    """409 if this mushaf already has a run in flight.

    Two runs would race over the same Page rows and the same sura/aya carry-over,
    so a mushaf gets one at a time.
    """
    if active_for(mushaf_id) is not None:
        raise HttpError(409, i18n.t("process_already_running"))


def _ensure_capacity(user: User | None) -> None:
    """429 if the box (or this user) is already busy enough.

    Detection is CPU-bound, so an unbounded number of concurrent runs does not
    mean more throughput — it means every run gets slower. Counted rather than
    semaphored because the limit has to hold across worker processes.
    """
    running = ProcessJob.objects.exclude(state__in=TERMINAL_STATES)

    overall_cap = getattr(settings, "MAX_CONCURRENT_JOBS", 2)
    if overall_cap and running.count() >= overall_cap:
        raise HttpError(429, i18n.t("too_many_jobs"))

    per_user_cap = getattr(settings, "MAX_CONCURRENT_JOBS_PER_USER", 1)
    if user is not None and per_user_cap and running.filter(started_by=user).count() >= per_user_cap:
        raise HttpError(429, i18n.t("too_many_jobs_for_user", count=per_user_cap))


def start(
    mushaf: Mushaf,
    params: dict[str, Any],
    *,
    user: User | None = None,
    runner: Callable[[ProcessJob], None] | None = None,
    inline: bool | None = None,
) -> ProcessJob:
    """Register a processing job and set it going.

    ``runner`` (the work itself) and ``inline`` (run on this thread instead of a
    worker) exist for tests: the default path spawns a thread that calls
    :func:`api.services.processing.process`.
    """
    ensure_idle(mushaf.id)
    _ensure_capacity(user)

    start_page = int(params["page_range_start"])
    end_page = int(params["page_range_end"])
    job = ProcessJob.objects.create(
        mushaf=mushaf,
        started_by=user,
        page_range_start=start_page,
        page_range_end=end_page,
        total=max(0, end_page - start_page + 1),
        # Alive from the moment it exists, so a job that dies before its first
        # progress tick still ages out rather than blocking the mushaf forever.
        heartbeat_at=timezone.now(),
    )

    work = runner if runner is not None else _processing_runner(mushaf, params)
    if inline is None:
        inline = bool(getattr(settings, "PROCESS_JOBS_INLINE", False))

    if inline:
        _execute(job, work, threaded=False)
    else:
        thread = threading.Thread(target=_execute, args=(job, work), kwargs={"threaded": True}, daemon=True)
        thread.start()
    job.refresh_from_db()
    return job


def request_cancel(mushaf_id: uuid.UUID) -> ProcessJob:
    """Ask the mushaf's running job to stop at the next page boundary."""
    job = active_for(mushaf_id)
    if job is None:
        raise HttpError(404, i18n.t("no_active_process"))
    # A column write rather than a threading.Event: the worker may well be in a
    # different process, where an in-memory signal would never arrive.
    ProcessJob.objects.filter(pk=job.pk).update(cancel_requested=True)
    job.refresh_from_db()
    logger.info("Cancel requested for processing job %s (mushaf %s)", job.id, mushaf_id)
    return job


def cancel_requested(job_id: uuid.UUID) -> bool:
    """Fresh read of the cancel flag — what the pipeline polls between pages.

    Deliberately not cached on the model instance: the whole point is to observe
    a write made by another request, quite possibly in another process.
    """
    return bool(ProcessJob.objects.filter(pk=job_id).values_list("cancel_requested", flat=True).first())


def reset() -> None:
    """Drop all job rows. For tests only."""
    ProcessJob.objects.all().delete()


# ----------------------------------------------------------------------
# Execution
# ----------------------------------------------------------------------


def _touch(job_id: uuid.UUID, **fields: Any) -> None:
    """Update a job row without reading it back.

    ``.update()`` rather than ``.save()`` so two concurrent writes cannot clobber
    each other's columns, and so a progress tick costs one statement.
    """
    ProcessJob.objects.filter(pk=job_id).update(heartbeat_at=timezone.now(), **fields)


def settle(job_id: uuid.UUID, state: str, **fields: Any) -> None:
    """Record a job's final outcome."""
    _touch(job_id, state=state, phase="finished", current_page=None, ended_at=timezone.now(), **fields)


def _execute(job: ProcessJob, work: Callable[[ProcessJob], None], *, threaded: bool) -> None:
    """Run ``work``, and make sure the job settles whatever happens."""
    try:
        work(job)
    except Exception as exc:  # a job must never take the server down
        logger.exception("Processing job %s failed", job.id)
        settle(job.id, ProcessJobStateChoices.ERROR, error=str(exc) or exc.__class__.__name__)
    else:
        current = ProcessJob.objects.filter(pk=job.pk).values_list("state", flat=True).first()
        if current is not None and current not in TERMINAL_STATES:
            # `work` returned without settling the job — treat as an error rather
            # than leaving a poller waiting forever.
            settle(job.id, ProcessJobStateChoices.ERROR, error="Processing ended without a result.")
    finally:
        if threaded:
            # Each thread gets its own DB connection; without this the handle
            # stays open for the life of the (daemon) thread.
            connections.close_all()


def _processing_runner(mushaf: Mushaf, params: dict[str, Any]) -> Callable[[ProcessJob], None]:
    """Bind a mushaf + request settings into the callable a job executes."""

    def run(job: ProcessJob) -> None:
        def on_progress(phase: str, current_page: int | None, pages_saved: int) -> None:
            _touch(job.id, phase=phase, current_page=current_page, pages_saved=pages_saved)

        def on_run_started(run_id: uuid.UUID, log_url: str) -> None:
            # Recorded before any page is processed so that even a run that dies
            # mid-way can be traced to its row and its log.
            _touch(job.id, run_id=run_id, log_url=log_url or "")

        result = processing_service.process(
            mushaf,
            **params,
            should_cancel=lambda: cancel_requested(job.id),
            on_progress=on_progress,
            on_run_started=on_run_started,
        )
        settle(
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

    return run

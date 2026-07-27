"""In-process registry for long-running work, so the HTTP request doesn't wait.

Processing a page range takes seconds per page — minutes to hours for a whole
mushaf. Holding an HTTP request open for that is what forced the old design:
the frontend sliced the range into 50-page requests just to see progress, and a
run could not be stopped because nothing was listening for a stop.

Here the request only *starts* the work. A worker thread owns the run; the job
object is the shared state both sides see::

    POST   /process         -> 202, creates the job, returns it immediately
    GET    /process/job     -> poll it (progress, phase, final outcome)
    POST   /process/cancel  -> set the job's cancel Event

Cancellation is cooperative — the Event is polled by the pipeline between pages
(see core/pipeline.py) — because there is no safe way to kill a thread mid-write.
The cost is latency of at most one page; the benefit is that a cancelled run
settles cleanly with everything it finished already persisted.

Scope, deliberately: state lives in memory, not the DB, because it is *about a
process* rather than about the data. It therefore assumes ONE server process
(the intended deployment: a local single-user tool on Django's threaded
``runserver``). Under multiple workers a poll could hit a process that doesn't
know the job. A server restart forgets running jobs; their ``ProcessingRun``
rows are settled as ``interrupted`` by the next run on that mushaf.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from django.conf import settings
from django.db import connections
from ninja.errors import HttpError

from api import i18n
from api.models import Mushaf
from api.services import processing as processing_service

logger = logging.getLogger(__name__)

#: States a job can settle in. Anything else means it is still working.
TERMINAL_STATES = frozenset({"completed", "aborted_line_detection", "cancelled", "error"})

_LOCK = threading.RLock()
_JOBS: dict[uuid.UUID, ProcessJob] = {}
#: mushaf id -> its most recent job, so a client that reloaded the page (or a
#: second tab) can find the run in flight without knowing the job id.
_LATEST_BY_MUSHAF: dict[uuid.UUID, uuid.UUID] = {}


@dataclass
class ProcessJob:
    """Live state of one processing run. Mutated by the worker, read by requests.

    Every field is read and written under the module lock, so a poll always sees
    a coherent snapshot rather than a half-updated one.
    """

    id: uuid.UUID
    mushaf_id: uuid.UUID
    page_range_start: int
    page_range_end: int
    total: int
    state: str = "running"
    #: What the run is doing right now: starting/rendering/detecting/saving/finished.
    phase: str = "starting"
    #: Logical page currently being worked on.
    current_page: int | None = None
    #: Logical pages written to the DB so far — durable, not an estimate.
    pages_saved: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    cancel_requested: bool = False
    run_id: uuid.UUID | None = None
    log_url: str | None = None
    #: Logical page the run came to rest on (detection failure, or the page a
    #: cancel stopped before) — what "Resume from here" uses.
    stopped_on_page: int | None = None
    abort_info: dict | None = None
    error: str | None = None
    end_sura: int | None = None
    end_aya: int | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    @property
    def finished(self) -> bool:
        return self.state in TERMINAL_STATES

    def to_dict(self) -> dict:
        """Serializable snapshot, taken under the lock."""
        with _LOCK:
            return {
                "id": self.id,
                "mushaf_id": self.mushaf_id,
                "state": self.state,
                "phase": self.phase,
                "page_range_start": self.page_range_start,
                "page_range_end": self.page_range_end,
                "total": self.total,
                "pages_saved": self.pages_saved,
                "current_page": self.current_page,
                "cancel_requested": self.cancel_requested,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "run_id": self.run_id,
                "log_url": self.log_url,
                "stopped_on_page": self.stopped_on_page,
                "abort_info": self.abort_info,
                "error": self.error,
                "end_sura": self.end_sura,
                "end_aya": self.end_aya,
            }


# ----------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------


def get(job_id: uuid.UUID) -> ProcessJob | None:
    with _LOCK:
        return _JOBS.get(job_id)


def latest_for(mushaf_id: uuid.UUID) -> ProcessJob | None:
    """The mushaf's most recent job, running or settled (None if never run here)."""
    with _LOCK:
        job_id = _LATEST_BY_MUSHAF.get(mushaf_id)
        return _JOBS.get(job_id) if job_id else None


def active_for(mushaf_id: uuid.UUID) -> ProcessJob | None:
    """The mushaf's job if it is still working, else None."""
    job = latest_for(mushaf_id)
    return job if job is not None and not job.finished else None


def ensure_idle(mushaf_id: uuid.UUID) -> None:
    """409 if this mushaf already has a run in flight.

    Two runs would race over the same Page rows and the same sura/aya carry-over,
    so a mushaf gets one at a time.
    """
    if active_for(mushaf_id) is not None:
        raise HttpError(409, i18n.t("process_already_running"))


def start(
    mushaf: Mushaf,
    params: dict[str, Any],
    *,
    runner: Callable[[ProcessJob], None] | None = None,
    inline: bool | None = None,
) -> ProcessJob:
    """Register a processing job and set it going.

    ``runner`` (the work itself) and ``inline`` (run on this thread instead of a
    worker) exist for tests: the default path spawns a thread that calls
    :func:`api.services.processing.process`.
    """
    ensure_idle(mushaf.id)

    start_page = int(params["page_range_start"])
    end_page = int(params["page_range_end"])
    job = ProcessJob(
        id=uuid.uuid4(),
        mushaf_id=mushaf.id,
        page_range_start=start_page,
        page_range_end=end_page,
        total=max(0, end_page - start_page + 1),
    )

    with _LOCK:
        previous = _LATEST_BY_MUSHAF.get(mushaf.id)
        if previous is not None:
            # Only the newest job per mushaf is retained, so the registry stays
            # bounded by the number of mushafs rather than by runs over time.
            _JOBS.pop(previous, None)
        _JOBS[job.id] = job
        _LATEST_BY_MUSHAF[mushaf.id] = job.id

    work = runner if runner is not None else _processing_runner(mushaf, params)
    if inline is None:
        inline = bool(getattr(settings, "PROCESS_JOBS_INLINE", False))

    if inline:
        _execute(job, work, threaded=False)
    else:
        thread = threading.Thread(target=_execute, args=(job, work), kwargs={"threaded": True}, daemon=True)
        thread.start()
    return job


def request_cancel(mushaf_id: uuid.UUID) -> ProcessJob:
    """Ask the mushaf's running job to stop at the next page boundary."""
    job = active_for(mushaf_id)
    if job is None:
        raise HttpError(404, i18n.t("no_active_process"))
    with _LOCK:
        job.cancel_requested = True
    job.cancel_event.set()
    logger.info("Cancel requested for processing job %s (mushaf %s)", job.id, mushaf_id)
    return job


def reset() -> None:
    """Drop all registry state. For tests only."""
    with _LOCK:
        _JOBS.clear()
        _LATEST_BY_MUSHAF.clear()


# ----------------------------------------------------------------------
# Execution
# ----------------------------------------------------------------------


def _execute(job: ProcessJob, work: Callable[[ProcessJob], None], *, threaded: bool) -> None:
    """Run ``work``, and make sure the job settles whatever happens."""
    try:
        work(job)
    except Exception as exc:  # a job must never take the server down
        logger.exception("Processing job %s failed", job.id)
        with _LOCK:
            job.state = "error"
            job.error = str(exc) or exc.__class__.__name__
    finally:
        with _LOCK:
            if not job.finished:
                # `work` returned without settling the job — treat as an error
                # rather than leaving a poller waiting forever.
                job.state = "error"
                job.error = job.error or "Processing ended without a result."
            job.phase = "finished"
            job.current_page = None
            job.ended_at = datetime.now(UTC)
        if threaded:
            # Each thread gets its own DB connection; without this the SQLite
            # handle stays open for the life of the (daemon) thread.
            connections.close_all()


def _processing_runner(mushaf: Mushaf, params: dict[str, Any]) -> Callable[[ProcessJob], None]:
    """Bind a mushaf + request settings into the callable a job executes."""

    def run(job: ProcessJob) -> None:
        def on_progress(phase: str, current_page: int | None, pages_saved: int) -> None:
            with _LOCK:
                job.phase = phase
                job.current_page = current_page
                job.pages_saved = pages_saved

        def on_run_started(run_id: uuid.UUID, log_url: str) -> None:
            # Recorded before any page is processed so that even a run that dies
            # mid-way can be traced to its row and its log.
            with _LOCK:
                job.run_id = run_id
                job.log_url = log_url

        result = processing_service.process(
            mushaf,
            **params,
            should_cancel=job.cancel_event.is_set,
            on_progress=on_progress,
            on_run_started=on_run_started,
        )
        with _LOCK:
            job.state = result["status"]
            job.run_id = result["run_id"]
            job.log_url = result["log_url"]
            job.pages_saved = result["pages_saved"]
            job.stopped_on_page = result["stopped_on_page"]
            job.abort_info = result["abort_info"]
            job.end_sura = result["end_sura"]
            job.end_aya = result["end_aya"]

    return run

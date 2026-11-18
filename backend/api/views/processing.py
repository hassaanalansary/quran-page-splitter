"""Processing endpoints: start a detection run in the background, watch it, stop it.

The run itself is owned by a job (see ``api.services.jobs``), not by an HTTP request —
``POST /process`` returns as soon as the job is registered.
"""

import uuid
from datetime import datetime

from django.http import HttpRequest, HttpResponse
from ninja import Router, Schema
from pydantic import Field

from api.auth import current_user
from api.common import RectSchema
from api.models import ProcessJobKindChoices
from api.services import mushaf as mushaf_service
from api.services import processing as processing_service
from api.services.jobs.cancellation import request_job_cancellation
from api.services.jobs.kinds.detection import start_detection_job
from api.services.jobs.queries import find_latest_job_of_mushaf
from api.services.jobs.serializers import serialize_job

router = Router(tags=["processing"])


class ProcessIn(Schema):
    page_range_start: int = Field(ge=1)
    page_range_end: int = Field(ge=1)
    start_sura: int = Field(ge=1, le=114)
    start_aya: int = Field(ge=1)
    bounds: RectSchema
    padding: int = 4
    expected_lines: int = Field(default=15, ge=1)
    sura_header_slots: int = Field(default=1, ge=1)
    sura_header_threshold: float = Field(default=0.6, ge=0, le=1)
    max_sura_headers: int = Field(default=3, ge=1)
    match_threshold: float = Field(default=0.35, ge=0, le=1)
    alternate_horizontal_margin: bool = False
    prefer_acceleration: bool = True


class JobOut(Schema):
    """Live state of a processing run — the single shape the client polls."""

    id: uuid.UUID
    mushaf_id: uuid.UUID
    #: ``queued`` until a worker claims it, ``running`` while it works; then
    #: ``completed`` / ``aborted_line_detection`` / ``cancelled`` / ``error`` /
    #: ``interrupted``.
    state: str
    #: A queued job's place in the queue: how many queued jobs were requested
    #: before it. Null once the job is no longer queued.
    queue_position: int | None = None
    #: ``starting`` / ``rendering`` / ``detecting`` / ``saving`` / ``finished``.
    phase: str
    page_range_start: int
    page_range_end: int
    total: int
    #: Logical pages already written to the DB — survives a cancel.
    pages_saved: int
    current_page: int | None = None
    cancel_requested: bool = False
    #: When the job was asked for.
    requested_at: datetime
    #: When a worker began it: null while the job is queued. An elapsed timer
    #: counts from here, so the wait in the queue is not shown as work.
    run_started_at: datetime | None = None
    ended_at: datetime | None = None
    run_id: uuid.UUID | None = None
    log_url: str | None = None
    #: Where to resume from: the page detection failed on, or the page a cancel
    #: stopped before.
    stopped_on_page: int | None = None
    abort_info: dict | None = None
    error: str | None = None
    #: Which engine this run drives — ``detection`` or ``words``. The client reads
    #: it to know whether the counter below or ``pages_saved`` is the real progress.
    kind: str = ProcessJobKindChoices.DETECTION
    #: A word run's span. Detection *reports* where it ended up and so fills only the
    #: end; a word run is *asked* for both, and a span that may now cross suras is
    #: not described by its end alone.
    start_sura: int | None = None
    start_aya: int | None = None
    end_sura: int | None = None
    end_aya: int | None = None
    #: Word runs only: lines written so far. Detection counts pages and leaves this
    #: at zero. It is what the word run's progress bar and its cancel dialog read,
    #: and on a whole-mushaf run it is the only sign of life for twenty minutes.
    lines_done: int = 0
    #: Calibration batches only: each page's outcome so far — processed, skipped and
    #: why, or failed. See ``api.services.calibration_batch``.
    report: dict | None = None


class JobStatusOut(Schema):
    """Wrapper so "no run on record" is a normal 200, not a 404."""

    job: JobOut | None = None


class RunLogTailOut(Schema):
    """One slice of a run log, plus where the next poll should resume."""

    #: Byte offset to send back as ``offset`` next time.
    offset: int
    #: Current size of the log — ``offset < size`` means more is already waiting.
    size: int
    text: str
    #: The log was replaced or truncated; discard what you have and start over.
    reset: bool


class RunOut(Schema):
    id: uuid.UUID
    run_number: int
    created_at: datetime
    status: str
    page_range_start: int
    page_range_end: int
    pages_saved: int
    settings: dict
    abort_info: dict | None = None
    log_url: str | None = None


@router.post("/{mushaf_id}/process", response={202: JobOut})
def process(request: HttpRequest, mushaf_id: uuid.UUID, data: ProcessIn) -> tuple[int, dict]:
    """Start detection over a logical page range; returns at once with the job.

    409 if this mushaf already has a job queued or running — one at a time, since
    two runs would fight over the same Page rows. 429 if the user already has as
    many jobs as one user may have, or the queue is full.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    job = start_detection_job(mushaf, data.model_dump(), user=current_user(request))
    return 202, serialize_job(job)


@router.get("/{mushaf_id}/process/job", response=JobStatusOut)
def process_job(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """The mushaf's current or most recent run — the client's polling endpoint.

    Answers after a page reload too: the job is keyed by mushaf, not by a handle
    the browser had to keep.
    """
    job = find_latest_job_of_mushaf(mushaf_id, kind=ProcessJobKindChoices.DETECTION)
    return {"job": serialize_job(job) if job else None}


@router.post("/{mushaf_id}/process/cancel", response=JobOut)
def cancel_process(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Ask the running job to stop; 404 when nothing is running.

    Returns immediately — the run stops at the next page boundary, so poll
    ``/process/job`` for the settled outcome. Pages already written stay written.
    """
    job = request_job_cancellation(mushaf_id, kind=ProcessJobKindChoices.DETECTION)
    return serialize_job(job)


@router.get("/{mushaf_id}/runs", response=list[RunOut])
def list_runs(request: HttpRequest, mushaf_id: uuid.UUID) -> list[dict]:
    """Processing-run history for a mushaf (newest first)."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return processing_service.list_runs(mushaf)


@router.get("/{mushaf_id}/runs/{run_id}/log")
def run_log(request: HttpRequest, mushaf_id: uuid.UUID, run_id: uuid.UUID) -> HttpResponse:
    """Return a processing run's detailed log file as plain text."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    path = processing_service.run_log_file(mushaf, run_id)
    return HttpResponse(path.read_text(encoding="utf-8"), content_type="text/plain; charset=utf-8")


@router.get("/{mushaf_id}/runs/{run_id}/log/tail", response=RunLogTailOut)
def run_log_tail(
    request: HttpRequest,
    mushaf_id: uuid.UUID,
    run_id: uuid.UUID,
    offset: int = 0,
) -> dict:
    """Read a run's log forward from ``offset`` — what the live viewer polls.

    Separate from ``/log`` (which stays a whole-file download) because a viewer
    watching a run in flight wants only what it has not seen yet.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return processing_service.read_run_log_tail(mushaf, run_id, offset)

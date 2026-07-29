"""Processing endpoints: start a detection run in the background, watch it, stop it.

The run itself is owned by a job (see services/jobs.py), not by an HTTP request —
``POST /process`` returns as soon as the job is registered.
"""

import uuid
from datetime import datetime

from django.http import HttpRequest, HttpResponse
from ninja import Router, Schema
from pydantic import Field

from api.common import RectSchema
from api.services import jobs as jobs_service
from api.services import mushaf as mushaf_service
from api.services import processing as processing_service

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
    match_threshold: float = Field(default=0.5, ge=0, le=1)
    alternate_horizontal_margin: bool = False
    prefer_acceleration: bool = True


class JobOut(Schema):
    """Live state of a processing run — the single shape the client polls."""

    id: uuid.UUID
    mushaf_id: uuid.UUID
    #: ``running`` while working; then ``completed`` / ``aborted_line_detection``
    #: / ``cancelled`` / ``error``.
    state: str
    #: ``starting`` / ``rendering`` / ``detecting`` / ``saving`` / ``finished``.
    phase: str
    page_range_start: int
    page_range_end: int
    total: int
    #: Logical pages already written to the DB — survives a cancel.
    pages_saved: int
    current_page: int | None = None
    cancel_requested: bool = False
    started_at: datetime
    ended_at: datetime | None = None
    run_id: uuid.UUID | None = None
    log_url: str | None = None
    #: Where to resume from: the page detection failed on, or the page a cancel
    #: stopped before.
    stopped_on_page: int | None = None
    abort_info: dict | None = None
    error: str | None = None
    end_sura: int | None = None
    end_aya: int | None = None


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

    409 if this mushaf already has a run in flight — one at a time, since two
    runs would fight over the same Page rows.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    params = data.model_dump()
    # Busy first, then payload: "a run is already going" is the more useful answer
    # even when the new request is also malformed. Both must be settled here —
    # once the job is registered the response has gone and nothing can be rejected.
    jobs_service.ensure_idle(mushaf.id)
    processing_service.preflight(mushaf, params["page_range_start"], params["page_range_end"])
    job = jobs_service.start(mushaf, params)
    return 202, job.to_dict()


@router.get("/{mushaf_id}/process/job", response=JobStatusOut)
def process_job(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """The mushaf's current or most recent run — the client's polling endpoint.

    Answers after a page reload too: the job is keyed by mushaf, not by a handle
    the browser had to keep.
    """
    job = jobs_service.latest_for(mushaf_id)
    return {"job": job.to_dict() if job else None}


@router.post("/{mushaf_id}/process/cancel", response=JobOut)
def cancel_process(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Ask the running job to stop; 404 when nothing is running.

    Returns immediately — the run stops at the next page boundary, so poll
    ``/process/job`` for the settled outcome. Pages already written stay written.
    """
    job = jobs_service.request_cancel(mushaf_id)
    return job.to_dict()


@router.get("/{mushaf_id}/runs", response=list[RunOut])
def list_runs(request: HttpRequest, mushaf_id: uuid.UUID) -> list[dict]:
    """Processing-run history for a mushaf (newest first)."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    return processing_service.list_runs(mushaf)


@router.get("/{mushaf_id}/runs/{run_id}/log")
def run_log(request: HttpRequest, mushaf_id: uuid.UUID, run_id: uuid.UUID) -> HttpResponse:
    """Return a processing run's detailed log file as plain text."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
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
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    return processing_service.read_run_log_tail(mushaf, run_id, offset)

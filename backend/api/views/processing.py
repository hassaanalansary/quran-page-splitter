"""Processing endpoint: run detection over a page range and persist the results."""

import uuid
from datetime import datetime

from django.http import HttpRequest, HttpResponse
from ninja import Router, Schema
from pydantic import Field

from api.common import RectSchema
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


class ProcessOut(Schema):
    run_id: uuid.UUID
    status: str
    pages_processed: int
    start_sura: int
    start_aya: int
    end_sura: int
    end_aya: int
    results: list[dict]
    abort_info: dict | None = None
    log_url: str | None = None


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


@router.post("/{mushaf_id}/process", response=ProcessOut)
def process(request: HttpRequest, mushaf_id: uuid.UUID, data: ProcessIn) -> dict:
    """Process a logical page range and persist Page/Line/Segment rows."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    return processing_service.process(mushaf, **data.model_dump())


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

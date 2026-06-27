"""Processing endpoint: run detection over a page range and persist the results."""

import uuid

from django.http import HttpRequest
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


@router.post("/{mushaf_id}/process", response=ProcessOut)
def process(request: HttpRequest, mushaf_id: uuid.UUID, data: ProcessIn) -> dict:
    """Process a logical page range and persist Page/Line/Segment rows."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    return processing_service.process(mushaf, **data.model_dump())

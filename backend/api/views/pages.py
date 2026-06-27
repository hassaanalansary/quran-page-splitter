"""Per-page coordinate read/save (the review surface)."""

import uuid

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from api.common import RectSchema
from api.services import editing as editing_service

router = Router(tags=["pages"])


class SegmentSchema(Schema):
    id: uuid.UUID | None = None
    segment_order: int
    bbox_x: int
    bbox_w: int
    has_separator: bool = False
    aya_number: int | None = None
    sura_number: int | None = None


class LineSchema(Schema):
    id: uuid.UUID | None = None
    line_number: int
    type: str
    sura_number: int | None = None
    bbox_x: int
    bbox_y: int
    bbox_w: int
    bbox_h: int
    segments: list[SegmentSchema] = Field(default_factory=list)


class PageDataOut(Schema):
    page_number: int
    bbox: RectSchema | None = None
    lines: list[LineSchema]


class PageSaveIn(Schema):
    bbox: RectSchema
    lines: list[LineSchema]


@router.get("/{mushaf_id}/pages/{page_number}", response=PageDataOut)
def get_page(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> dict:
    return editing_service.get_page_data(mushaf_id, page_number)


@router.post("/{mushaf_id}/pages/{page_number}", response=PageDataOut)
def save_page(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: PageSaveIn) -> dict:
    return editing_service.save_page(
        mushaf_id=mushaf_id,
        page_number=page_number,
        bbox=data.bbox.model_dump(),
        lines=[line.model_dump() for line in data.lines],
    )

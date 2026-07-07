"""Per-page coordinate read/save (the review surface)."""

import uuid

from django.http import HttpRequest, JsonResponse
from ninja import Router, Schema
from pydantic import Field

from api.common import EraseStrokeSchema, RectSchema
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
    # Cut-layer state (output-only; ignored on the review-save path). Populated
    # by ``page_to_dict`` so the Finalize editor can round-trip saved erases.
    erase_strokes: list[EraseStrokeSchema] = Field(default_factory=list)


class PageDataOut(Schema):
    page_number: int
    bbox: RectSchema | None = None
    lines: list[LineSchema]


class PageSaveIn(Schema):
    bbox: RectSchema
    lines: list[LineSchema]


class PageSuraOut(Schema):
    number: int
    transliteration: str
    name_arabic: str


class PageSummaryOut(Schema):
    page_number: int
    reviewed: bool
    source_pdf_page: int
    lines: int
    ayat: int
    segments: int
    has_header: bool
    suras: list[PageSuraOut] = Field(default_factory=list)


class BulkPageIn(Schema):
    page_number: int
    bbox: RectSchema
    lines: list[LineSchema] = Field(default_factory=list)


class BulkSaveIn(Schema):
    pages: list[BulkPageIn] = Field(default_factory=list)
    reviewed_pages: list[int] = Field(default_factory=list)


@router.get("/{mushaf_id}/pages", response=list[PageSummaryOut])
def list_pages(request: HttpRequest, mushaf_id: uuid.UUID) -> list[dict]:
    return editing_service.list_pages(mushaf_id)


@router.get("/{mushaf_id}/review-data")
def review_data(request: HttpRequest, mushaf_id: uuid.UUID) -> JsonResponse:
    """Whole-document review payload: numbering seed + all processed pages.

    Hand-serialized (no ``response=`` schema) so the large payload skips Pydantic
    validation/re-serialization on the way out — a big chunk of the response time.
    """
    return JsonResponse(editing_service.review_data(mushaf_id))


@router.post("/{mushaf_id}/pages/bulk")
def bulk_save(request: HttpRequest, mushaf_id: uuid.UUID, data: BulkSaveIn) -> JsonResponse:
    """Save edited pages + review flags in one transaction; returns fresh review data."""
    return JsonResponse(
        editing_service.bulk_save(
            mushaf_id=mushaf_id,
            pages=[p.model_dump() for p in data.pages],
            reviewed_pages=data.reviewed_pages,
        )
    )


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

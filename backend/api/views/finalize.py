"""Finalize (cut layer) + transparent line-PNG export."""

import uuid

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from api.common import RectSchema
from api.services import editing as editing_service
from api.services import export as export_service
from api.views.pages import PageDataOut

router = Router(tags=["finalize"])


class EraseStrokeSchema(Schema):
    brush_size: int = 12
    points: list[list[int]] = Field(default_factory=list)


class LineFinalizeSchema(Schema):
    line_number: int
    bbox_override: RectSchema | None = None
    erase_strokes: list[EraseStrokeSchema] = Field(default_factory=list)


class FinalizeIn(Schema):
    lines: list[LineFinalizeSchema] = Field(default_factory=list)


class ExportedLineSchema(Schema):
    line_number: int
    line_png: str


class ExportOut(Schema):
    page_number: int
    exported: int
    lines: list[ExportedLineSchema]


@router.post("/{mushaf_id}/pages/{page_number}/finalize", response=PageDataOut)
def finalize(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: FinalizeIn) -> dict:
    return editing_service.save_finalize(
        mushaf_id=mushaf_id,
        page_number=page_number,
        line_edits=[line.model_dump() for line in data.lines],
    )


@router.post("/{mushaf_id}/pages/{page_number}/export-lines", response=ExportOut)
def export_lines(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> dict:
    return export_service.export_lines(mushaf_id=mushaf_id, page_number=page_number)

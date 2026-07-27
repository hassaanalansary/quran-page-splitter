"""Finalize (cut layer) + transparent line-PNG export."""

import uuid

from django.http import FileResponse, HttpRequest
from ninja import Router, Schema
from pydantic import Field

from api.common import EraseStrokeSchema, RectSchema
from api.services import editing as editing_service
from api.services import export as export_service
from api.views.pages import PageDataOut

router = Router(tags=["finalize"])


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


@router.get("/{mushaf_id}/lines.zip")
def download_lines_zip(request: HttpRequest, mushaf_id: uuid.UUID, page: int | None = None) -> FileResponse:
    """The exported line PNGs as a zip attachment — the whole mushaf, or one page.

    Lets the user put the images wherever they need them (the downstream mushaf
    app) instead of only reaching them one request at a time under /media.
    """
    filename, buffer = export_service.lines_zip(mushaf_id=mushaf_id, page_number=page)
    return FileResponse(buffer, as_attachment=True, filename=filename, content_type="application/zip")

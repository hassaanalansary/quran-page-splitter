# ruff: noqa: B008  -- Ninja's File() is meant to be used in a parameter default
"""Finalize (cut layer), transparent line-PNG export, and the work bundle."""

import uuid

from django.http import FileResponse, HttpRequest
from ninja import File, Router, Schema
from ninja.files import UploadedFile
from pydantic import Field

from api.auth import current_user
from api.common import EraseStrokeSchema, RectSchema
from api.services import bundle as bundle_service
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


class ImportWarningsOut(Schema):
    bounds_differ: bool = False
    page_count_differs: bool = False


class ImportOut(Schema):
    pages_imported: int
    lines_imported: int
    source_name: str = ""
    warnings: ImportWarningsOut


@router.post("/{mushaf_id}/pages/{page_number}/finalize", response=PageDataOut)
def finalize(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: FinalizeIn) -> dict:
    return editing_service.save_finalize(
        user=current_user(request),
        mushaf_id=mushaf_id,
        page_number=page_number,
        line_edits=[line.model_dump() for line in data.lines],
    )


@router.post("/{mushaf_id}/pages/{page_number}/export-lines", response=ExportOut)
def export_lines(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> dict:
    return export_service.export_lines(user=current_user(request), mushaf_id=mushaf_id, page_number=page_number)


@router.get("/{mushaf_id}/lines.zip")
def download_lines_zip(request: HttpRequest, mushaf_id: uuid.UUID, page: int | None = None) -> FileResponse:
    """The exported line PNGs as a zip attachment — the whole mushaf, or one page.

    Lets the user put the images wherever they need them (the downstream mushaf
    app) instead of only reaching them one request at a time under /media.
    """
    filename, buffer = export_service.lines_zip(user=current_user(request), mushaf_id=mushaf_id, page_number=page)
    return FileResponse(buffer, as_attachment=True, filename=filename, content_type="application/zip")


@router.get("/{mushaf_id}/bundle")
def download_bundle(request: HttpRequest, mushaf_id: uuid.UUID) -> FileResponse:
    """The mushaf's work as a portable zip (schema mushaf-work/v1).

    Carries the geometry and templates but not the PDF — it names the PDF by
    sha256 instead, and import refuses unless the target was built from it.
    """
    filename, buffer = bundle_service.build(mushaf_id, user=current_user(request))
    return FileResponse(buffer, as_attachment=True, filename=filename, content_type="application/zip")


@router.post("/{mushaf_id}/import", response=ImportOut)
def import_bundle(
    request: HttpRequest,
    mushaf_id: uuid.UUID,
    file: UploadedFile = File(...),
    replace: bool = False,
) -> dict:
    """Apply a work bundle to this mushaf. Refuses on a PDF-hash mismatch."""
    return bundle_service.apply_bundle(mushaf_id, file, user=current_user(request), replace=replace)

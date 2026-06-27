# ruff: noqa: B008  -- Ninja's File()/Form() are meant to be used in parameter defaults
"""Mushaf CRUD, template upload, and on-demand page rendering.

Endpoints are thin: each parses/returns schemas and calls one service function.
"""

import uuid
from datetime import datetime

from django.http import HttpRequest, HttpResponse
from ninja import File, Form, Router, Schema
from ninja.files import UploadedFile

from api.services import mushaf as mushaf_service

router = Router(tags=["mushafs"])


class MushafForm(Schema):
    name: str
    qiraa: str | None = None
    first_quran_pdf_page: int = 1
    last_quran_pdf_page: int | None = None


class MushafOut(Schema):
    id: uuid.UUID
    name: str
    qiraa: str | None = None
    pdf_page_count: int
    first_quran_pdf_page: int
    last_quran_pdf_page: int
    logical_page_count: int
    processed_page_count: int
    reviewed_page_count: int
    created_at: datetime
    updated_at: datetime


class WarningsSchema(Schema):
    duplicate_file: bool = False


class MushafCreateOut(Schema):
    mushaf: MushafOut
    warnings: WarningsSchema


class MushafPatchIn(Schema):
    name: str | None = None
    qiraa: str | None = None
    first_quran_pdf_page: int | None = None
    last_quran_pdf_page: int | None = None


class TemplateForm(Schema):
    ignore_x: int | None = None
    ignore_y: int | None = None
    ignore_w: int | None = None
    ignore_h: int | None = None


class TemplateOut(Schema):
    id: uuid.UUID
    type: str
    image_url: str
    ignore_rects: dict


@router.get("", response=list[MushafOut])
def list_mushafs(request: HttpRequest) -> list[dict]:
    return mushaf_service.list_mushafs()


@router.post("", response={201: MushafCreateOut})
def create_mushaf(
    request: HttpRequest,
    pdf: UploadedFile = File(...),
    data: MushafForm = Form(...),
) -> tuple[int, dict]:
    result = mushaf_service.create_mushaf(
        pdf_file=pdf,
        name=data.name,
        qiraa=data.qiraa,
        first_quran_pdf_page=data.first_quran_pdf_page,
        last_quran_pdf_page=data.last_quran_pdf_page,
    )
    return 201, result


@router.get("/{mushaf_id}", response=MushafOut)
def get_mushaf(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    return mushaf_service.get_mushaf_dict(mushaf_id)


@router.patch("/{mushaf_id}", response=MushafOut)
def update_mushaf(request: HttpRequest, mushaf_id: uuid.UUID, data: MushafPatchIn) -> dict:
    """Patch name / qiraa / Quran-page bounds (only the fields actually sent)."""
    return mushaf_service.update_mushaf(mushaf_id, data.model_dump(exclude_unset=True))


@router.delete("/{mushaf_id}", response={204: None})
def delete_mushaf(request: HttpRequest, mushaf_id: uuid.UUID) -> tuple[int, None]:
    mushaf_service.delete_mushaf(mushaf_id)
    return 204, None


@router.put("/{mushaf_id}/templates/{template_type}", response=TemplateOut)
def put_template(
    request: HttpRequest,
    mushaf_id: uuid.UUID,
    template_type: str,
    image: UploadedFile = File(...),
    data: TemplateForm = Form(...),
) -> dict:
    return mushaf_service.upsert_template(
        mushaf_id=mushaf_id,
        template_type=template_type,
        image=image,
        ignore_x=data.ignore_x,
        ignore_y=data.ignore_y,
        ignore_w=data.ignore_w,
        ignore_h=data.ignore_h,
    )


@router.get("/{mushaf_id}/pages/{page_number}/image")
def page_image(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> HttpResponse:
    png = mushaf_service.render_page_image(mushaf_id, page_number)
    return HttpResponse(png, content_type="image/png")

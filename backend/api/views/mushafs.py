# ruff: noqa: B008  -- Ninja's File()/Form() are meant to be used in parameter defaults
"""Mushaf CRUD, template upload, and on-demand page rendering.

Endpoints are thin: each parses/returns schemas and calls one service function.
"""

import json
import uuid
from datetime import datetime

from django.http import HttpRequest, HttpResponse, StreamingHttpResponse
from django.utils.http import content_disposition_header
from ninja import File, Form, Router, Schema
from ninja.files import UploadedFile

from api.auth import current_user
from api.services import activity as activity_service
from api.services import data_export as data_export_service
from api.services import export as export_service
from api.services import gallery as gallery_service
from api.services import mushaf as mushaf_service
from api.views.gallery import GalleryDetailOut, PublishIn

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
    thumbnail_url: str | None = None
    visibility: str = "private"
    created_at: datetime
    updated_at: datetime


class CountingSystemOut(Schema):
    name: str
    name_arabic: str
    total_ayat: int


class UsualSuraHeaderOut(Schema):
    #: The padding the latest checked pages all gave their sura headers; null when they differ.
    padding: int | None = None
    #: Whether they all had their headers' edge ink erased; null when they differ.
    erase_edge_ink: bool | None = None


class MushafDetailOut(MushafOut):
    """MushafOut plus the extra fields the detail page needs (never on the list)."""

    counting_system: CountingSystemOut | None = None
    pdf_url: str | None = None
    pdf_file_size: int = 0
    pdf_original_name: str = ""
    published_at: datetime | None = None
    description: str = ""
    #: "box" | "uniform" | "tight" | "tight_uniform" — how tall each exported line PNG is.
    line_png_size: str = "box"
    #: Pages whose line cuts a person marked checked in Finalize.
    finalized_page_count: int = 0
    #: The padding the latest checked pages agree on (``find_usual_line_padding``),
    #: applied to a page that opens in Finalize with none yet; null when they differ.
    usual_line_padding: int | None = None
    #: How the latest checked pages finished their sura headers
    #: (find_usual_sura_header_edits), for the headers of a page opening unpadded.
    usual_sura_header: UsualSuraHeaderOut | None = None
    #: "report" | "ignore" — whether word detection checks a word against the dots
    #: its spelling expects. A fact about the printing, not about the text.
    ijam_mode: str = "report"


class ActivityEventOut(Schema):
    id: uuid.UUID
    type: str
    payload: dict
    created_at: datetime


class MushafStatsOut(Schema):
    lines_cut: int
    segments: int
    ayat_found: int
    sura_headers: int
    besmella_lines: int
    exported_pngs: int


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
    line_png_size: str | None = None
    ijam_mode: str | None = None


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
def list_mushafs(request: HttpRequest, qiraa: str | None = None) -> list[dict]:
    return mushaf_service.list_mushafs(user=current_user(request), qiraa=qiraa)


@router.post("", response={201: MushafCreateOut})
def create_mushaf(
    request: HttpRequest,
    pdf: UploadedFile = File(...),
    data: MushafForm = Form(...),
) -> tuple[int, dict]:
    result = mushaf_service.create_mushaf(
        owner=current_user(request),
        pdf_file=pdf,
        name=data.name,
        qiraa=data.qiraa,
        first_quran_pdf_page=data.first_quran_pdf_page,
        last_quran_pdf_page=data.last_quran_pdf_page,
    )
    return 201, result


@router.get("/{mushaf_id}", response=MushafDetailOut)
def get_mushaf(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    return mushaf_service.get_mushaf_detail(mushaf_id, user=current_user(request))


@router.get("/{mushaf_id}/stats", response=MushafStatsOut)
def mushaf_stats(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Aggregate detection counts (ayat, lines, segments, exported PNGs)."""
    return mushaf_service.mushaf_stats(mushaf_id, user=current_user(request))


@router.get("/{mushaf_id}/activity", response=list[ActivityEventOut])
def list_activity(request: HttpRequest, mushaf_id: uuid.UUID, limit: int = 50) -> list[dict]:
    """Newest-first activity feed (uploads, templates, runs, review saves, exports)."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return activity_service.list_events(mushaf, limit=limit)


@router.get("/{mushaf_id}/coordinates")
def download_coordinates(request: HttpRequest, mushaf_id: uuid.UUID) -> HttpResponse:
    """The aya-coordinates JSON document (schema aya-bbox/v1), as an attachment."""
    filename, doc = export_service.coordinates_json(mushaf_id, user=current_user(request))
    response = HttpResponse(
        json.dumps(doc, ensure_ascii=False, indent=2),
        content_type="application/json; charset=utf-8",
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


@router.get("/{mushaf_id}/export.zip")
def download_export(
    request: HttpRequest, mushaf_id: uuid.UUID, page: int | None = None, images: bool = True, maps: bool = True
) -> StreamingHttpResponse:
    """The full data export (schema mushaf-export/v2): every line, aya, word and blob,
    in page and line-PNG pixels, with each line's word and blob maps — the whole mushaf,
    or one page. Streamed as it is made. See ``api.services.data_export``.
    """
    filename, chunks = data_export_service.archive(
        mushaf_id, user=current_user(request), page_number=page, images=images, maps=maps
    )
    response = StreamingHttpResponse(chunks, content_type="application/zip")
    # Through Django's helper: a mushaf's name is often Arabic, which a plain
    # ``filename="…"`` cannot carry in a header.
    response["Content-Disposition"] = content_disposition_header(as_attachment=True, filename=filename)
    return response


@router.post("/{mushaf_id}/thumbnail", response=MushafDetailOut)
def regenerate_thumbnail(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Re-render the cover thumbnail from physical page 1."""
    return mushaf_service.regenerate_thumbnail(mushaf_id, user=current_user(request))


@router.patch("/{mushaf_id}", response=MushafOut)
def update_mushaf(request: HttpRequest, mushaf_id: uuid.UUID, data: MushafPatchIn) -> dict:
    """Patch name / qiraa / Quran-page bounds (only the fields actually sent)."""
    return mushaf_service.update_mushaf(mushaf_id, data.model_dump(exclude_unset=True), user=current_user(request))


@router.delete("/{mushaf_id}", response={204: None})
def delete_mushaf(request: HttpRequest, mushaf_id: uuid.UUID) -> tuple[int, None]:
    mushaf_service.delete_mushaf(mushaf_id, user=current_user(request))
    return 204, None


@router.post("/{mushaf_id}/publish", response=GalleryDetailOut)
def publish_mushaf(request: HttpRequest, mushaf_id: uuid.UUID, data: PublishIn) -> dict:
    """List this mushaf in the public gallery, with an optional blurb."""
    return gallery_service.publish(mushaf_id, user=current_user(request), description=data.description)


@router.post("/{mushaf_id}/unpublish", response=GalleryDetailOut)
def unpublish_mushaf(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Take it out of the gallery. Copies others already made keep working."""
    return gallery_service.unpublish(mushaf_id, user=current_user(request))


@router.get("/{mushaf_id}/templates", response=list[TemplateOut])
def list_templates(request: HttpRequest, mushaf_id: uuid.UUID) -> list[dict]:
    return mushaf_service.list_templates(mushaf_id, user=current_user(request))


@router.put("/{mushaf_id}/templates/{template_type}", response=TemplateOut)
def put_template(
    request: HttpRequest,
    mushaf_id: uuid.UUID,
    template_type: str,
    data: TemplateForm = Form(...),
    image: UploadedFile | None = File(None),
) -> dict:
    return mushaf_service.upsert_template(
        user=current_user(request),
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
    png = mushaf_service.render_page_image(mushaf_id, page_number, user=current_user(request))
    return HttpResponse(png, content_type="image/png")

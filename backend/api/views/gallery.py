"""The public gallery — the only routes reachable without a session.

Kept as its own router rather than opening up `/api/mushafs/*` per-operation, so
that every anonymous-readable endpoint in the project is visible in one file.
The router is registered with ``auth=None``; the two owner-only operations
(publish/unpublish) opt back in explicitly.
"""

import json
import uuid
from datetime import datetime

from django.http import FileResponse, HttpRequest, HttpResponse
from ninja import Router, Schema
from ninja.security import django_auth

from api.auth import current_user, optional_user
from api.services import cloning as cloning_service
from api.services import export as export_service
from api.services import gallery as gallery_service

router = Router(tags=["gallery"])


class GalleryItemOut(Schema):
    id: uuid.UUID
    name: str
    description: str = ""
    qiraa: str | None = None
    logical_page_count: int
    processed_page_count: int
    reviewed_page_count: int
    thumbnail_url: str | None = None
    published_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    owner_name: str
    #: True when the caller is signed in as this mushaf's author.
    is_owner: bool = False


class GalleryDetailOut(GalleryItemOut):
    visibility: str
    pdf_page_count: int
    first_quran_pdf_page: int
    last_quran_pdf_page: int
    line_count: int
    exported_line_count: int


class GalleryListOut(Schema):
    total: int
    items: list[GalleryItemOut]


class PublishIn(Schema):
    description: str | None = None


class DuplicateOut(Schema):
    id: uuid.UUID
    name: str


@router.get("", response=GalleryListOut, auth=None)
def list_gallery(
    request: HttpRequest,
    qiraa: str | None = None,
    limit: int = 24,
    offset: int = 0,
) -> dict:
    """Published mushafs, newest first. Open to everyone."""
    return gallery_service.list_published(
        user=optional_user(request), qiraa=qiraa, limit=limit, offset=offset
    )


@router.get("/{mushaf_id}", response=GalleryDetailOut, auth=None)
def gallery_detail(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    return gallery_service.get_published(mushaf_id, user=optional_user(request))


@router.get("/{mushaf_id}/coordinates", auth=None)
def gallery_coordinates(request: HttpRequest, mushaf_id: uuid.UUID) -> HttpResponse:
    """The aya-coordinates JSON (schema aya-bbox/v1) for a published mushaf."""
    filename, doc = export_service.coordinates_json(mushaf_id, user=optional_user(request))
    response = HttpResponse(
        json.dumps(doc, ensure_ascii=False, indent=2),
        content_type="application/json; charset=utf-8",
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


@router.get("/{mushaf_id}/lines.zip", auth=None)
def gallery_lines_zip(request: HttpRequest, mushaf_id: uuid.UUID, page: int | None = None) -> FileResponse:
    """The exported line PNGs of a published mushaf, as a zip."""
    filename, buffer = export_service.lines_zip(user=optional_user(request), mushaf_id=mushaf_id, page_number=page)
    return FileResponse(buffer, as_attachment=True, filename=filename, content_type="application/zip")


@router.post("/{mushaf_id}/duplicate", response={201: DuplicateOut}, auth=django_auth)
def duplicate(request: HttpRequest, mushaf_id: uuid.UUID) -> tuple[int, dict]:
    """Copy a published mushaf into your own account.

    Requires a session — unlike browsing and downloading, this writes rows that
    have to belong to someone.
    """
    copy = cloning_service.duplicate_by_id(mushaf_id, owner=current_user(request))
    return 201, {"id": copy.id, "name": copy.name}

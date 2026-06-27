"""Mushaf and template orchestration — the ORM + wiring layer.

Views call these functions and never touch the ORM directly. Serialization to
plain dicts also lives here so the engine and views stay decoupled from models.
"""

import uuid

from django.core.files.base import ContentFile
from django.core.files.uploadedfile import UploadedFile
from django.db.models import Count
from django.shortcuts import get_object_or_404
from ninja.errors import HttpError

from api import validators
from api.models import Mushaf, Page, Qiraa, Template, TemplateTypeChoices
from api.services import pdf

# Columns read straight from the DB for serialization. ``processed_page_count``
# is annotated in the same query (no per-row COUNT), so list views avoid N+1.
_MUSHAF_VALUES = (
    "id",
    "name",
    "qiraa__name",
    "pdf_page_count",
    "first_quran_pdf_page",
    "last_quran_pdf_page",
    "created_at",
    "updated_at",
)


def get_mushaf(mushaf_id: uuid.UUID) -> Mushaf:
    """Fetch a mushaf instance or raise 404 (for paths that mutate or render it)."""
    return get_object_or_404(Mushaf, id=mushaf_id)


def _serialize(row: dict) -> dict:
    """Shape an annotated ``.values()`` row into the API representation."""
    first = row["first_quran_pdf_page"]
    last = row["last_quran_pdf_page"]
    return {
        "id": row["id"],
        "name": row["name"],
        "qiraa": row["qiraa__name"],
        "pdf_page_count": row["pdf_page_count"],
        "first_quran_pdf_page": first,
        "last_quran_pdf_page": last,
        "logical_page_count": last - first + 1,
        "processed_page_count": row["processed_page_count"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_mushafs() -> list[dict]:
    """All mushafs, newest first (single query; page counts annotated)."""
    rows = (
        Mushaf.objects.annotate(processed_page_count=Count("pages"))
        .values(*_MUSHAF_VALUES, "processed_page_count")
        .order_by("-created_at")
    )
    return [_serialize(row) for row in rows]


def get_mushaf_dict(mushaf_id: uuid.UUID) -> dict:
    """Serialized single mushaf (404 if missing)."""
    row = (
        Mushaf.objects.filter(id=mushaf_id)
        .annotate(processed_page_count=Count("pages"))
        .values(*_MUSHAF_VALUES, "processed_page_count")
        .first()
    )
    if row is None:
        raise HttpError(404, "Mushaf not found.")
    return _serialize(row)


def create_mushaf(
    *,
    pdf_file: UploadedFile,
    name: str,
    qiraa: str | None,
    first_quran_pdf_page: int,
    last_quran_pdf_page: int | None,
) -> dict:
    """Store a PDF mushaf, compute its hash + page count, and create the record.

    The unique ``name`` is enforced (409 on conflict). An identical file uploaded
    under a different name is allowed and flagged via ``warnings.duplicate_file``.
    """
    if Mushaf.objects.filter(name=name).exists():
        raise HttpError(409, f"A mushaf named {name!r} already exists.")

    data = pdf_file.read()
    sha = pdf.sha256_of(data)
    count = pdf.page_count(data)
    last = last_quran_pdf_page or count
    validators.validate_pdf_bounds(first_quran_pdf_page, last, count)

    qiraa_obj = Qiraa.objects.filter(name=qiraa).first() if qiraa else None
    duplicate_file = Mushaf.objects.filter(pdf_sha256=sha).exists()

    mushaf = Mushaf(
        name=name,
        qiraa=qiraa_obj,
        pdf_sha256=sha,
        pdf_page_count=count,
        first_quran_pdf_page=first_quran_pdf_page,
        last_quran_pdf_page=last,
    )
    mushaf.pdf_file.save(f"{sha}.pdf", ContentFile(data), save=False)
    mushaf.save()

    return {
        "mushaf": get_mushaf_dict(mushaf.id),
        "warnings": {"duplicate_file": duplicate_file},
    }


def delete_mushaf(mushaf_id: uuid.UUID) -> None:
    """Delete a mushaf and (via cascade) all its pages/lines/segments/templates."""
    get_mushaf(mushaf_id).delete()


def upsert_template(
    *,
    mushaf_id: uuid.UUID,
    template_type: str,
    image: UploadedFile,
    ignore_x: int | None,
    ignore_y: int | None,
    ignore_w: int | None,
    ignore_h: int | None,
) -> dict:
    """Create or replace one template (unique per mushaf+type)."""
    if template_type not in TemplateTypeChoices.values:
        raise HttpError(400, f"Invalid template type {template_type!r}.")

    mushaf = get_mushaf(mushaf_id)
    ignore_rect: dict = {}
    if None not in (ignore_x, ignore_y, ignore_w, ignore_h):
        ignore_rect = {"x": ignore_x, "y": ignore_y, "w": ignore_w, "h": ignore_h}

    template, _ = Template.objects.update_or_create(
        mushaf=mushaf, type=template_type, defaults={"ignore_rects": ignore_rect}
    )
    template.image.save(f"{template_type}.png", image, save=True)
    return {
        "id": template.id,
        "type": template.type,
        "image_url": template.image.url,
        "ignore_rects": template.ignore_rects,
    }


def render_page_image(mushaf_id: uuid.UUID, page_number: int) -> bytes:
    """Render a logical page to PNG bytes (honoring a per-page source override)."""
    mushaf = get_mushaf(mushaf_id)
    validators.validate_page_number(mushaf, page_number)
    override = (
        Page.objects.filter(mushaf=mushaf, page_number=page_number).values_list("source_pdf_page", flat=True).first()
    )
    index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page_number, override)
    return pdf.render_page(mushaf.pdf_file.path, index)

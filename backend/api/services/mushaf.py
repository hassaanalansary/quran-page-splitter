"""Mushaf and template orchestration — the ORM + wiring layer.

Views call these functions and never touch the ORM directly. Serialization to
plain dicts also lives here so the engine and views stay decoupled from models.
"""

import logging
import uuid

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import UploadedFile
from django.db.models import Count, Q, Sum
from django.shortcuts import get_object_or_404
from ninja.errors import HttpError

from api import i18n, validators
from api.models import (
    ActivityTypeChoices,
    Line,
    LineTypeChoices,
    Mushaf,
    Page,
    Qiraa,
    Segment,
    SuraAyaCount,
    Template,
    TemplateTypeChoices,
)
from api.services import activity, pdf

logger = logging.getLogger(__name__)

# Low-DPI render of the cover page used for list thumbnails.
THUMBNAIL_DPI = 50


def _media_url(name: str | None) -> str | None:
    """Absolute (leading-slash) media URL for a stored file name, or None."""
    if not name:
        return None
    return "/" + (settings.MEDIA_URL + name).lstrip("/")


def generate_thumbnail(mushaf: Mushaf) -> None:
    """Render the first physical PDF page (the cover) at low DPI as the thumbnail."""
    try:
        png = pdf.render_page(mushaf.pdf_file.path, 1, dpi=THUMBNAIL_DPI)
    except Exception:  # best-effort; a missing thumbnail just falls back to on-demand render
        return
    mushaf.thumbnail.save(f"{mushaf.pdf_sha256}_thumb.png", ContentFile(png), save=True)


# Columns read straight from the DB for serialization. ``processed_page_count``
# is annotated in the same query (no per-row COUNT), so list views avoid N+1.
_MUSHAF_VALUES = (
    "id",
    "name",
    "qiraa__name",
    "pdf_page_count",
    "first_quran_pdf_page",
    "last_quran_pdf_page",
    "thumbnail",
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
        "reviewed_page_count": row["reviewed_page_count"],
        "thumbnail_url": _media_url(row["thumbnail"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_mushafs(qiraa: str | None = None) -> list[dict]:
    """All mushafs, newest first (single query; page counts annotated)."""
    rows = (
        Mushaf.objects.annotate(
            processed_page_count=Count("pages"),
            reviewed_page_count=Count("pages", filter=Q(pages__reviewed=True)),
        )
        .values(*_MUSHAF_VALUES, "processed_page_count", "reviewed_page_count")
        .order_by("-created_at")
    )
    if qiraa is not None:
        qiraa = qiraa.strip().lower()
        rows = rows.filter(qiraa__name__iexact=qiraa)
    return [_serialize(row) for row in rows]


def get_mushaf_dict(mushaf_id: uuid.UUID) -> dict:
    """Serialized single mushaf (404 if missing)."""
    row = (
        Mushaf.objects.filter(id=mushaf_id)
        .annotate(
            processed_page_count=Count("pages"),
            reviewed_page_count=Count("pages", filter=Q(pages__reviewed=True)),
        )
        .values(*_MUSHAF_VALUES, "processed_page_count", "reviewed_page_count")
        .first()
    )
    if row is None:
        raise HttpError(404, i18n.t("mushaf_not_found"))
    return _serialize(row)


def get_mushaf_detail(mushaf_id: uuid.UUID) -> dict:
    """Serialized mushaf enriched for the detail page: counting system + source file.

    A superset of ``get_mushaf_dict`` (the lean list shape), kept separate so the
    list endpoint never pays for the counting-system sum or the file stat.
    """
    data = get_mushaf_dict(mushaf_id)  # 404s if missing
    mushaf = Mushaf.objects.select_related("qiraa__counting_system").get(id=mushaf_id)

    counting_system = None
    system = mushaf.qiraa.counting_system if mushaf.qiraa else None
    if system is not None:
        total = SuraAyaCount.objects.filter(counting_system=system).aggregate(total=Sum("count"))["total"]
        counting_system = {"name": system.name, "name_arabic": system.name_arabic, "total_ayat": total or 0}

    data["counting_system"] = counting_system
    data["pdf_url"] = _media_url(mushaf.pdf_file.name) if mushaf.pdf_file else None
    data["pdf_file_size"] = mushaf.pdf_file.size if mushaf.pdf_file else 0
    data["pdf_original_name"] = mushaf.pdf_original_name
    return data


def regenerate_thumbnail(mushaf_id: uuid.UUID) -> dict:
    """Re-render the cover thumbnail from physical page 1; returns the detail dict."""
    mushaf = get_mushaf(mushaf_id)
    if mushaf.thumbnail:
        mushaf.thumbnail.delete(save=False)
    generate_thumbnail(mushaf)
    return get_mushaf_detail(mushaf.id)


def mushaf_stats(mushaf_id: uuid.UUID) -> dict:
    """Aggregate detection counts across all of a mushaf's processed pages.

    Feeds the detail page's stat strips (ayat / lines / segments / exported PNGs).
    ``ayat_found`` counts segments that close an aya (i.e. carry a separator).
    """
    mushaf = get_mushaf(mushaf_id)  # 404s if missing
    lines = Line.objects.filter(page__mushaf=mushaf)
    segments = Segment.objects.filter(line__page__mushaf=mushaf)
    line_counts = lines.aggregate(
        lines_cut=Count("id"),
        sura_headers=Count("id", filter=Q(type=LineTypeChoices.SURA_HEADER)),
        besmella_lines=Count("id", filter=Q(type=LineTypeChoices.BESMELLA)),
        exported_pngs=Count("id", filter=Q(line_png__isnull=False) & ~Q(line_png="")),
    )
    seg_counts = segments.aggregate(
        segments=Count("id"),
        ayat_found=Count("id", filter=Q(has_separator=True)),
    )
    return {**line_counts, **seg_counts}


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
        raise HttpError(409, i18n.t("mushaf_name_exists", name=name))

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
        pdf_original_name=pdf_file.name or "",
        pdf_sha256=sha,
        pdf_page_count=count,
        first_quran_pdf_page=first_quran_pdf_page,
        last_quran_pdf_page=last,
    )
    mushaf.pdf_file.save(f"{sha}.pdf", ContentFile(data), save=False)
    mushaf.save()
    generate_thumbnail(mushaf)
    activity.emit(mushaf, ActivityTypeChoices.MUSHAF_CREATED, {"pdf_original_name": mushaf.pdf_original_name})

    return {
        "mushaf": get_mushaf_dict(mushaf.id),
        "warnings": {"duplicate_file": duplicate_file},
    }


def update_mushaf(mushaf_id: uuid.UUID, fields: dict) -> dict:
    """Patch a mushaf's name / qiraa / Quran-page bounds (only the given fields).

    ``fields`` holds just the keys the client sent (PATCH semantics), so an
    explicit ``{"qiraa": None}`` clears the link while an absent key leaves it
    untouched. Name uniqueness is re-checked (409). Bounds may only change while
    the mushaf is unprocessed — shifting first/last would desync the
    logical->physical mapping of stored pages (revert = reprocess).
    """
    mushaf = get_mushaf(mushaf_id)

    if "name" in fields:
        name = fields["name"]
        if Mushaf.objects.filter(name=name).exclude(id=mushaf.id).exists():
            raise HttpError(409, i18n.t("mushaf_name_exists", name=name))
        mushaf.name = name

    if "qiraa" in fields:
        qiraa = fields["qiraa"]
        mushaf.qiraa = Qiraa.objects.filter(name=qiraa).first() if qiraa else None

    bounds_changed = False
    if "first_quran_pdf_page" in fields or "last_quran_pdf_page" in fields:
        first = fields.get("first_quran_pdf_page", mushaf.first_quran_pdf_page)
        last = fields.get("last_quran_pdf_page", mushaf.last_quran_pdf_page)
        validators.validate_pdf_bounds(first, last, mushaf.pdf_page_count)
        bounds_changed = first != mushaf.first_quran_pdf_page or last != mushaf.last_quran_pdf_page
        if bounds_changed and mushaf.pages.exists():
            raise HttpError(409, i18n.t("bounds_locked"))
        mushaf.first_quran_pdf_page = first
        mushaf.last_quran_pdf_page = last

    mushaf.save()
    if bounds_changed:
        activity.emit(
            mushaf,
            ActivityTypeChoices.BOUNDS_SET,
            {"first": mushaf.first_quran_pdf_page, "last": mushaf.last_quran_pdf_page},
        )
    return get_mushaf_dict(mushaf.id)


def delete_mushaf(mushaf_id: uuid.UUID) -> None:
    """Delete a mushaf and (via cascade) all its pages/lines/segments/templates."""
    mushaf = get_mushaf(mushaf_id)
    if mushaf.pdf_file:
        mushaf.pdf_file.delete(save=False)
    if mushaf.thumbnail:
        mushaf.thumbnail.delete(save=False)
    mushaf.delete()


def _serialize_template(template: Template) -> dict:
    return {
        "id": template.id,
        "type": template.type,
        "image_url": _media_url(template.image.name) or "",
        "ignore_rects": template.ignore_rects,
    }


def list_templates(mushaf_id: uuid.UUID) -> list[dict]:
    """All saved templates for a mushaf (so the editor can rehydrate on revisit)."""
    mushaf = get_mushaf(mushaf_id)
    return [_serialize_template(t) for t in mushaf.templates.order_by("type")]


def upsert_template(
    *,
    mushaf_id: uuid.UUID,
    template_type: str,
    image: UploadedFile | None,
    ignore_x: int | None,
    ignore_y: int | None,
    ignore_w: int | None,
    ignore_h: int | None,
) -> dict:
    """Create or replace one template (unique per mushaf+type).

    ``image`` is optional: omit it to update only the ignore region of an existing
    template (e.g. when the picture is already in the DB after a reload).
    """
    if template_type not in TemplateTypeChoices.values:
        raise HttpError(400, i18n.t("invalid_template_type", template_type=template_type))

    mushaf = get_mushaf(mushaf_id)
    ignore_rect: dict = {}
    if None not in (ignore_x, ignore_y, ignore_w, ignore_h):
        ignore_rect = {"x": ignore_x, "y": ignore_y, "w": ignore_w, "h": ignore_h}

    if image is None and not Template.objects.filter(mushaf=mushaf, type=template_type).exists():
        raise HttpError(400, i18n.t("template_image_required"))

    template, _ = Template.objects.update_or_create(
        mushaf=mushaf, type=template_type, defaults={"ignore_rects": ignore_rect}
    )
    if image is not None:
        # Django suffixes a new upload rather than overwriting, so every redrawn
        # crop used to leave its predecessor behind forever. Only the row's
        # current image is ever read, so the one it replaced can go.
        superseded = template.image.name
        template.image.save(f"{template_type}.png", image, save=True)
        if superseded and superseded != template.image.name:
            try:
                template.image.storage.delete(superseded)
            except OSError:
                logger.warning("Could not delete superseded template image %s", superseded)
    activity.emit(mushaf, ActivityTypeChoices.TEMPLATE_SAVED, {"template_type": template_type})
    return _serialize_template(template)


def render_page_image(mushaf_id: uuid.UUID, page_number: int) -> bytes:
    """Render a logical page to PNG bytes (honoring a per-page source override)."""
    mushaf = get_mushaf(mushaf_id)
    validators.validate_page_number(mushaf, page_number)
    override = (
        Page.objects.filter(mushaf=mushaf, page_number=page_number).values_list("source_pdf_page", flat=True).first()
    )
    index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page_number, override)
    return pdf.render_page(mushaf.pdf_file.path, index)

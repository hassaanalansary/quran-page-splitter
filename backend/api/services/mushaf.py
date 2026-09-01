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

from accounts.models import User
from api import i18n, validators
from api.models import (
    ActivityTypeChoices,
    Line,
    LineTypeChoices,
    Mushaf,
    Page,
    Segment,
    Template,
    TemplateTypeChoices,
    VisibilityChoices,
)
from api.services import activity, pdf
from quran.models import Rawi, SuraAyaCount

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
    mushaf.thumbnail.save("thumbnail.png", ContentFile(png), save=True)


# Columns read straight from the DB for serialization. ``processed_page_count``
# is annotated in the same query (no per-row COUNT), so list views avoid N+1.
_MUSHAF_VALUES = (
    "id",
    "name",
    "rawi__name",
    "pdf_page_count",
    "first_quran_pdf_page",
    "last_quran_pdf_page",
    "thumbnail",
    "visibility",
    "created_at",
    "updated_at",
)


def get_mushaf(mushaf_id: uuid.UUID, *, user: User | None, write: bool = True) -> Mushaf:
    """Fetch a mushaf the caller is allowed to touch, or raise 404.

    404 rather than 403 for someone else's private mushaf: a 403 would confirm
    that the id exists, which is exactly what someone probing ids wants to learn.

    Access is: the owner may do anything; anyone at all — signed in or not — may
    *read* a published one. ``user`` is None for anonymous gallery visitors.
    Writes always require ownership, so publishing never hands out an edit path.
    """
    mushaf = get_object_or_404(Mushaf, id=mushaf_id)
    if user is not None and mushaf.owner_id == user.pk:
        return mushaf
    if not write and mushaf.visibility == VisibilityChoices.PUBLISHED:
        return mushaf
    raise HttpError(404, i18n.t("mushaf_not_found"))


def get_page(mushaf: Mushaf, page_number: int, *, message: str = "page_not_found") -> Page:
    """One of a mushaf's pages, or the 404 that says which way it went wrong.

    Two different failures, and telling them apart is the point. ``validate_page_number``
    answers "could this mushaf have a page 500?" — bounds, without reading the table.
    This then answers "has page 3 been processed?" A number can pass the first and fail
    the second on every mushaf that has not been run yet, so a caller wants both and
    wants to know which one bit.

    ``message`` is a key rather than a string because the useful half of the second
    404 is the verb: "no page to export" and "no page to finalize" send a reader
    somewhere different.
    """
    validators.validate_page_number(mushaf, page_number)
    page = Page.objects.filter(mushaf=mushaf, page_number=page_number).first()
    if page is None:
        raise HttpError(404, i18n.t(message, page=page_number))
    return page


def _serialize(row: dict) -> dict:
    """Shape an annotated ``.values()`` row into the API representation."""
    first = row["first_quran_pdf_page"]
    last = row["last_quran_pdf_page"]
    return {
        "id": row["id"],
        "name": row["name"],
        "qiraa": row["rawi__name"],
        "pdf_page_count": row["pdf_page_count"],
        "first_quran_pdf_page": first,
        "last_quran_pdf_page": last,
        "logical_page_count": last - first + 1,
        "processed_page_count": row["processed_page_count"],
        "reviewed_page_count": row["reviewed_page_count"],
        "thumbnail_url": _media_url(row["thumbnail"]),
        "visibility": row["visibility"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_mushafs(*, user: User, qiraa: str | None = None, pdf_sha256: str | None = None) -> list[dict]:
    """The caller's mushafs, newest first (single query; page counts annotated).

    ``pdf_sha256`` narrows the list to the ones built from one specific PDF —
    what the work-bundle detector asks for. Several rows can share a hash: the
    same file may be registered more than once on purpose (see
    ``create_mushaf``'s ``duplicate_file`` warning), so callers must be ready
    for more than one answer.
    """
    rows = (
        Mushaf.objects.filter(owner=user)
        .annotate(
            processed_page_count=Count("pages"),
            reviewed_page_count=Count("pages", filter=Q(pages__reviewed=True)),
        )
        .values(*_MUSHAF_VALUES, "processed_page_count", "reviewed_page_count")
        .order_by("-created_at")
    )
    if qiraa is not None:
        qiraa = qiraa.strip().lower()
        rows = rows.filter(rawi__name__iexact=qiraa)
    if pdf_sha256:
        rows = rows.filter(pdf_sha256=pdf_sha256)
    return [_serialize(row) for row in rows]


def get_mushaf_dict(mushaf_id: uuid.UUID, *, user: User) -> dict:
    """Serialized single mushaf (404 if missing or not the caller's)."""
    row = (
        Mushaf.objects.filter(id=mushaf_id, owner=user)
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


def get_mushaf_detail(mushaf_id: uuid.UUID, *, user: User) -> dict:
    """Serialized mushaf enriched for the detail page: counting system + source file.

    A superset of ``get_mushaf_dict`` (the lean list shape), kept separate so the
    list endpoint never pays for the counting-system sum or the file stat.
    """
    data = get_mushaf_dict(mushaf_id, user=user)  # 404s if missing or not theirs
    mushaf = Mushaf.objects.select_related("rawi__qiraa__counting_system").get(id=mushaf_id)

    counting_system = None
    system = mushaf.rawi.counting_system if mushaf.rawi else None
    if system is not None:
        total = SuraAyaCount.objects.filter(counting_system=system).aggregate(total=Sum("count"))["total"]
        counting_system = {"name": system.name, "name_arabic": system.name_arabic, "total_ayat": total or 0}

    data["counting_system"] = counting_system
    data["pdf_url"] = _media_url(mushaf.pdf_file.name) if mushaf.pdf_file else None
    data["pdf_file_size"] = mushaf.pdf_file.size if mushaf.pdf_file else 0
    data["pdf_original_name"] = mushaf.pdf_original_name
    # So the details page can show the publish control without a second request.
    data["visibility"] = mushaf.visibility
    data["published_at"] = mushaf.published_at
    data["description"] = mushaf.description
    data["export_uniform_size"] = mushaf.export_uniform_size
    return data


def regenerate_thumbnail(mushaf_id: uuid.UUID, *, user: User) -> dict:
    """Re-render the cover thumbnail from physical page 1; returns the detail dict."""
    mushaf = get_mushaf(mushaf_id, user=user)
    if mushaf.thumbnail:
        _delete_if_unshared(mushaf, "thumbnail")
    generate_thumbnail(mushaf)
    return get_mushaf_detail(mushaf.id, user=user)


def mushaf_stats(mushaf_id: uuid.UUID, *, user: User | None) -> dict:
    """Aggregate detection counts across all of a mushaf's processed pages.

    Feeds the detail page's stat strips (ayat / lines / segments / exported PNGs).
    ``ayat_found`` counts segments that close an aya (i.e. carry a separator).
    """
    mushaf = get_mushaf(mushaf_id, user=user, write=False)  # 404s if missing
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


def _stored_twin(sha: str) -> Mushaf | None:
    """An existing mushaf whose stored files this upload can point at instead of
    writing its own copy, or ``None`` if there is no usable one.

    Uploads are named by content hash, so a row with the same ``pdf_sha256``
    already has these exact bytes on disk. Storage is checked rather than
    trusted: a row can outlive its file (a hand-cleaned media dir, a half-done
    storage migration), and pointing a new mushaf at a missing file would break
    it on the first render.
    """
    twins = Mushaf.objects.filter(pdf_sha256=sha).exclude(pdf_file="").order_by("created_at")
    for twin in twins.iterator():
        name = twin.pdf_file.name
        if name and twin.pdf_file.storage.exists(name):
            return twin
    return None


def _copy_thumbnail_from(source: Mushaf | None, target: Mushaf) -> bool:
    """Copy ``source``'s cover into ``target``'s own directory. False if there is none.

    A few KB, so unlike the PDF this is copied outright rather than shared —
    which is what lets ``mushafs/<id>/`` hold everything that mushaf owns.
    """
    if source is None or not source.thumbnail:
        return False
    try:
        source.thumbnail.open("rb")
        target.thumbnail.save("thumbnail.png", ContentFile(source.thumbnail.read()), save=True)
    except (OSError, ValueError):
        # A missing cover just means we render a fresh one.
        return False
    finally:
        source.thumbnail.close()
    return True


def create_mushaf(
    *,
    owner: User,
    pdf_file: UploadedFile,
    name: str,
    qiraa: str | None,
    first_quran_pdf_page: int,
    last_quran_pdf_page: int | None,
) -> dict:
    """Store a PDF mushaf, compute its hash + page count, and create the record.

    ``name`` is unique per owner (409 on conflict) — two people may each have
    their own "مصحف المدينة". An identical file uploaded under a different name
    is allowed, flagged via ``warnings.duplicate_file``, and **costs no storage**:
    the new row is pointed at the bytes already held rather than storing a second
    copy of a ~150 MB scan. See ``_stored_twin``.
    """
    if Mushaf.objects.filter(owner=owner, name=name).exists():
        raise HttpError(409, i18n.t("mushaf_name_exists", name=name))

    data = pdf_file.read()
    sha = pdf.sha256_of(data)
    count = pdf.page_count(data)
    last = last_quran_pdf_page or count
    validators.validate_pdf_bounds(first_quran_pdf_page, last, count)

    rawi = Rawi.objects.filter(name=qiraa).first() if qiraa else None
    duplicate_file = Mushaf.objects.filter(pdf_sha256=sha).exists()
    twin = _stored_twin(sha) if duplicate_file else None

    mushaf = Mushaf(
        owner=owner,
        name=name,
        rawi=rawi,
        pdf_original_name=pdf_file.name or "",
        pdf_sha256=sha,
        pdf_page_count=count,
        first_quran_pdf_page=first_quran_pdf_page,
        last_quran_pdf_page=last,
    )
    if twin is not None:
        # Assigning the *path* instead of calling .save() is what makes this
        # free — the same move services/cloning.py uses to duplicate a mushaf,
        # and what _delete_if_unshared already expects to find.
        #
        # Two identical uploads racing here both miss and both write, leaving a
        # suffixed second copy. That is exactly today's behaviour, so the race
        # costs nothing that locking every upload would be worth.
        mushaf.pdf_file.name = twin.pdf_file.name
    else:
        mushaf.pdf_file.save(f"{sha}.pdf", ContentFile(data), save=False)
    mushaf.save()

    # The cover renders from physical page 1, so identical bytes give an
    # identical thumbnail — copying the twin's bytes skips a whole PDF render.
    # Copied rather than shared by path: thumbnails live inside the mushaf's own
    # directory now, so each row needs its own (they are a few KB).
    if not _copy_thumbnail_from(twin, mushaf):
        generate_thumbnail(mushaf)
    activity.emit(
        mushaf,
        ActivityTypeChoices.MUSHAF_CREATED,
        {"pdf_original_name": mushaf.pdf_original_name},
        actor=owner,
    )

    return {
        "mushaf": get_mushaf_dict(mushaf.id, user=owner),
        "warnings": {"duplicate_file": duplicate_file},
    }


def update_mushaf(mushaf_id: uuid.UUID, fields: dict, *, user: User) -> dict:
    """Patch a mushaf's name / qiraa / Quran-page bounds (only the given fields).

    ``fields`` holds just the keys the client sent (PATCH semantics), so an
    explicit ``{"qiraa": None}`` clears the link while an absent key leaves it
    untouched. Name uniqueness is re-checked (409). Bounds may only change while
    the mushaf is unprocessed — shifting first/last would desync the
    logical->physical mapping of stored pages (revert = reprocess).
    """
    mushaf = get_mushaf(mushaf_id, user=user)

    if "name" in fields:
        name = fields["name"]
        if Mushaf.objects.filter(owner=user, name=name).exclude(id=mushaf.id).exists():
            raise HttpError(409, i18n.t("mushaf_name_exists", name=name))
        mushaf.name = name

    if "qiraa" in fields:
        qiraa = fields["qiraa"]
        mushaf.rawi = Rawi.objects.filter(name=qiraa).first() if qiraa else None

    if "export_uniform_size" in fields:
        # Affects future exports only — pages already exported keep the size
        # they were written at until they are exported again.
        mushaf.export_uniform_size = bool(fields["export_uniform_size"])

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
            actor=user,
        )
    return get_mushaf_dict(mushaf.id, user=user)


def _delete_if_unshared(mushaf: Mushaf, field_name: str) -> None:
    """Delete a mushaf's stored file, unless another mushaf points at it too.

    A ``FileField`` column holds a *path*, not the bytes, and uploads are named
    by content hash (``mushafs/{sha}.pdf``, ``thumbnails/{sha}_thumb.png``). So
    several rows legitimately reference one file on disk — that is what makes
    duplicating a mushaf cost no storage. Deleting unconditionally would pull
    the file out from under every other row sharing it.
    """
    field = getattr(mushaf, field_name)
    if not field:
        return
    shared = Mushaf.objects.filter(**{field_name: field.name}).exclude(id=mushaf.id).exists()
    if not shared:
        field.delete(save=False)


def delete_mushaf(mushaf_id: uuid.UUID, *, user: User) -> None:
    """Delete a mushaf and (via cascade) all its pages/lines/segments/templates."""
    mushaf = get_mushaf(mushaf_id, user=user)
    _delete_if_unshared(mushaf, "pdf_file")
    _delete_if_unshared(mushaf, "thumbnail")
    mushaf.delete()


def _serialize_template(template: Template) -> dict:
    return {
        "id": template.id,
        "type": template.type,
        "image_url": _media_url(template.image.name) or "",
        "ignore_rects": template.ignore_rects,
    }


def list_templates(mushaf_id: uuid.UUID, *, user: User) -> list[dict]:
    """All saved templates for a mushaf (so the editor can rehydrate on revisit)."""
    mushaf = get_mushaf(mushaf_id, user=user, write=False)
    return [_serialize_template(t) for t in mushaf.templates.order_by("type")]


def upsert_template(
    *,
    user: User,
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

    mushaf = get_mushaf(mushaf_id, user=user)
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
    activity.emit(mushaf, ActivityTypeChoices.TEMPLATE_SAVED, {"template_type": template_type}, actor=user)
    return _serialize_template(template)


def render_page_image(mushaf_id: uuid.UUID, page_number: int, *, user: User) -> bytes:
    """Render a logical page to PNG bytes (honoring a per-page source override)."""
    mushaf = get_mushaf(mushaf_id, user=user, write=False)
    validators.validate_page_number(mushaf, page_number)
    override = (
        Page.objects.filter(mushaf=mushaf, page_number=page_number).values_list("source_pdf_page", flat=True).first()
    )
    index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page_number, override)
    return pdf.render_page(mushaf.pdf_file.path, index)

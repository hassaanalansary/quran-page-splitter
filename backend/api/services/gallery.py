"""The public gallery: browsing and publishing shared mushafs.

Deliberately a separate module from ``services.mushaf``. Everything here is
reachable without a session, so keeping it in one file makes the public surface
auditable at a glance instead of scattered through the owner-scoped code.
"""

import uuid
from typing import Literal

from django.db.models import Count, ExpressionWrapper, F, FloatField, Q, QuerySet, Value
from django.db.models.functions import Greatest, Lower, StrIndex, Substr
from django.utils import timezone

from accounts.models import User
from api.models import Line, Mushaf, VisibilityChoices
from api.services import mushaf as mushaf_service

#: Columns read for a gallery card. ``owner__display_name`` and ``owner__email``
#: feed ``User.public_name``'s fallback — the raw address is never serialized.
#: ``owner_id`` is read only to compute ``is_owner``; it is never sent out.
_GALLERY_VALUES = (
    "id",
    "name",
    "description",
    "rawi__name",
    "pdf_page_count",
    "first_quran_pdf_page",
    "last_quran_pdf_page",
    "thumbnail",
    "published_at",
    "created_at",
    "updated_at",
    "owner_id",
    "owner__display_name",
    "owner__email",
)

MAX_PAGE_SIZE = 60

#: How the listing can be ordered: newest first, the most reviewed first, or by name.
GallerySort = Literal["published", "complete", "name"]


def _public_name(display_name: str, email: str) -> str:
    """Mirror of ``User.public_name`` for ``.values()`` rows (no model instance)."""
    return display_name or email.split("@")[0]


def _serialize(row: dict, *, viewer_id: object = None) -> dict:
    first = row["first_quran_pdf_page"]
    last = row["last_quran_pdf_page"]
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "qiraa": row["rawi__name"],
        "logical_page_count": last - first + 1,
        "processed_page_count": row["processed_page_count"],
        "reviewed_page_count": row["reviewed_page_count"],
        "thumbnail_url": mushaf_service._media_url(row["thumbnail"]),
        "published_at": row["published_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "owner_name": _public_name(row["owner__display_name"], row["owner__email"]),
        # Lets a card offer the owner the way *in* to their own mushaf instead of
        # offering to copy it to the account it is already in.
        "is_owner": viewer_id is not None and row["owner_id"] == viewer_id,
    }


def _with_counts(rows: QuerySet[Mushaf]) -> QuerySet[Mushaf]:
    return rows.annotate(
        processed_page_count=Count("pages", distinct=True),
        reviewed_page_count=Count("pages", filter=Q(pages__reviewed=True), distinct=True),
    )


def _matching(rows: QuerySet[Mushaf], search: str) -> QuerySet[Mushaf]:
    """Entries whose name, qiraa or author contains ``search``.

    The author is matched on the name the card shows: the display name, or for an
    account without one, the part of the address before the @. Never the whole
    address, so a search for a mail domain finds nothing.
    """
    rows = rows.annotate(
        owner_local=Substr("owner__email", 1, StrIndex("owner__email", Value("@")) - 1),
    )
    return rows.filter(
        Q(name__icontains=search)
        | Q(rawi__name__icontains=search)
        | Q(rawi__name_arabic__icontains=search)
        | Q(owner__display_name__icontains=search)
        | (Q(owner__display_name="") & Q(owner_local__icontains=search))
    )


def _completed(rows: QuerySet[Mushaf]) -> QuerySet[Mushaf]:
    """Every Quran page reviewed: the frontend's ``mushafStatus`` "completed"."""
    return rows.filter(
        processed_page_count__gt=0,
        reviewed_page_count__gte=F("last_quran_pdf_page") - F("first_quran_pdf_page") + 1,
    )


def _ordered(rows: QuerySet[Mushaf], sort: GallerySort) -> QuerySet[Mushaf]:
    newest = ("-published_at", "-created_at")
    if sort == "name":
        return rows.order_by(Lower("name"), *newest)
    if sort == "complete":
        # Ordered by the expressions themselves, not by annotations: the listing's
        # ``values()`` would drop an annotation it does not name.
        pages = Greatest(F("last_quran_pdf_page") - F("first_quran_pdf_page") + 1, 1)
        reviewed = ExpressionWrapper(F("reviewed_page_count") * 1.0 / pages, output_field=FloatField())
        processed = ExpressionWrapper(F("processed_page_count") * 1.0 / pages, output_field=FloatField())
        return rows.order_by(reviewed.desc(), processed.desc(), *newest)
    return rows.order_by(*newest)


def list_published(
    *,
    user: User | None = None,
    qiraa: str | None = None,
    search: str | None = None,
    completed: bool = False,
    sort: GallerySort = "published",
    limit: int = 24,
    offset: int = 0,
) -> dict:
    """Published mushafs, newest first unless ``sort`` says otherwise. No session required.

    ``user`` is optional and read-only: it only decides ``is_owner`` per card, so
    a signed-in author sees their own entries marked rather than being offered a
    copy of what they already own.

    ``facets`` counts the entries per qiraa under the same search and completed
    filters but not the qiraa one, so the gallery's chips can offer every qiraa
    there is something to find in, and "All" can say how many that is.
    """
    limit = max(1, min(limit, MAX_PAGE_SIZE))
    offset = max(0, offset)

    rows = Mushaf.objects.filter(visibility=VisibilityChoices.PUBLISHED).select_related("owner", "rawi")
    search = (search or "").strip()
    if search:
        rows = _matching(rows, search)
    rows = _with_counts(rows)
    if completed:
        rows = _completed(rows)

    # Grouped over the matching ids rather than over ``rows`` itself: regrouping
    # ``rows`` by qiraa would recount its page totals per qiraa and break the
    # completed filter, which is per mushaf.
    facets = (
        Mushaf.objects.filter(id__in=rows.values("id"), rawi__isnull=False)
        .values("rawi__name", "rawi__name_arabic")
        .annotate(count=Count("id"))
        .order_by("-count", "rawi__name")
    )
    everything = rows.count()
    if qiraa is not None:
        rows = rows.filter(rawi__name__iexact=qiraa.strip().lower())

    total = rows.count() if qiraa is not None else everything
    page = _ordered(rows, sort).values(*_GALLERY_VALUES, "processed_page_count", "reviewed_page_count")[
        offset : offset + limit
    ]
    viewer_id = user.pk if user is not None else None
    return {
        "total": total,
        "items": [_serialize(row, viewer_id=viewer_id) for row in page],
        "facets": {
            "all": everything,
            "qiraat": [
                {"name": row["rawi__name"], "name_arabic": row["rawi__name_arabic"], "count": row["count"]}
                for row in facets
            ],
        },
    }


def get_published(mushaf_id: uuid.UUID, *, user: User | None) -> dict:
    """One gallery entry, with the extra counts the read-only detail page shows.

    Readable by anyone if published; by its owner always.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user, write=False)
    row = (
        _with_counts(Mushaf.objects.filter(id=mushaf.id).select_related("owner", "rawi"))
        .values(*_GALLERY_VALUES, "processed_page_count", "reviewed_page_count")
        .first()
    )
    assert row is not None  # get_mushaf already proved it exists
    data = _serialize(row, viewer_id=user.pk if user is not None else None)
    data["visibility"] = mushaf.visibility
    data["pdf_page_count"] = row["pdf_page_count"]
    data["first_quran_pdf_page"] = row["first_quran_pdf_page"]
    data["last_quran_pdf_page"] = row["last_quran_pdf_page"]
    # Counted separately rather than as two more annotations on the query above:
    # joining pages *and* lines in one aggregate multiplies the rows, and these
    # are what tell a visitor whether the line-images download has anything in it.
    lines = Line.objects.filter(page__mushaf_id=mushaf.id)
    data["line_count"] = lines.count()
    # An upper bound on what the lines.zip download holds: the field is nullable
    # *and* blankable, so both empties are excluded. Unlike ``export.lines_zip``
    # this does not stat storage — one count beats thousands of file probes.
    data["exported_line_count"] = lines.filter(line_png__isnull=False).exclude(line_png="").count()
    return data


def publish(mushaf_id: uuid.UUID, *, user: User, description: str | None = None) -> dict:
    """List a mushaf in the public gallery. Owner only."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user)
    if description is not None:
        mushaf.description = description
    # Keep the original published_at if it is already listed, so re-publishing
    # to edit the description does not jump it back to the top of the gallery.
    if mushaf.visibility != VisibilityChoices.PUBLISHED:
        mushaf.visibility = VisibilityChoices.PUBLISHED
        mushaf.published_at = timezone.now()
    mushaf.save(update_fields=["description", "visibility", "published_at", "updated_at"])
    return get_published(mushaf.id, user=user)


def unpublish(mushaf_id: uuid.UUID, *, user: User) -> dict:
    """Remove a mushaf from the gallery. Existing copies are unaffected —
    they are independent rows and keep working."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user)
    mushaf.visibility = VisibilityChoices.PRIVATE
    mushaf.published_at = None
    mushaf.save(update_fields=["visibility", "published_at", "updated_at"])
    return get_published(mushaf.id, user=user)

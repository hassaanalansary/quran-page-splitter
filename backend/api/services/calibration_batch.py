"""Process many pages for calibration review in one job: *Process pages N to M*.

Page by page, every page waits about 45 seconds to be processed before it can be
reviewed. A batch processes a whole range in the background, one page after another,
and the pages are reviewed and confirmed afterwards in any order. The readiness meter
(:mod:`api.services.calibration_progress`) says when that stops costing anything.

This module decides what a batch does to each page. The job that walks the range and
does it is :mod:`api.services.jobs.kinds.calibration_batch`.

What a batch does to each page of its range::

    no draft yet                              processed               new
    a draft, still current                    left alone              current
                                                — or processed again  refresh   (with ``refresh``)
    a draft whose lines or neighbours
      changed since                           processed again         stale
    a confirmed page                          left alone              confirmed
    not reviewed, not numbered, not there     left alone              not_reviewed, not_numbered, missing

**What a person decided is kept.** A draft someone worked on is processed again like
any other: every word's box comes from the ink given to it, and the decisions on its
blobs — roles, owners, types, erases — are put back on every line whose pixels did not
change (``calibration._carry_decisions``). Only a confirmed page is never processed
over. ``process_page``'s revision check refuses a draft saved in the seconds between
deciding a page and storing it.

**The learning is fixed per page when it is processed**, as for one page: the pages
confirmed before it at that moment. A page confirmed while the batch runs teaches the
pages processed after it. Mark types are guessed whenever a page is opened, so those
always learn from every confirmed page — and ``refresh`` re-processes drafts when the
learning has grown since.
"""

from __future__ import annotations

from typing import Any

from django.db.models import Count, Q
from ninja.errors import HttpError

from api import i18n
from api.models import CalibrationReview, LineTypeChoices, Mushaf, Page, Segment
from api.services import calibration, calibration_progress

Doc = dict[str, Any]

#: Why a page is processed.
PROCESS = ("new", "refresh", "stale")
#: Why a page is left alone. ``drafted`` is only ever a plan's word: such a draft is
#: processed again when its sources changed (``stale``), and otherwise left (``current``).
SKIP = ("current", "confirmed", "not_reviewed", "not_numbered", "missing")


def _numbered(mushaf: Mushaf, first: int, last: int) -> set[int]:
    """The pages whose text lines' segments all carry an aya — the ones a span can be
    read for (``calibration.find_aya_span_of_page`` refuses the rest)."""
    counts = (
        Segment.objects.filter(
            line__page__mushaf=mushaf,
            line__page__page_number__gte=first,
            line__page__page_number__lte=last,
            line__type=LineTypeChoices.TEXT,
        )
        .values("line__page__page_number")
        .annotate(
            total=Count("id"),
            numbered=Count("id", filter=Q(aya_number__isnull=False, line__sura__isnull=False)),
        )
    )
    return {row["line__page__page_number"] for row in counts if row["total"] and row["total"] == row["numbered"]}


def _reviews(mushaf: Mushaf, first: int, last: int) -> dict[int, Doc]:
    """Each page's review in the few fields that decide it — never the drafts themselves,
    which are a thousand blobs a page."""
    rows = CalibrationReview.objects.filter(mushaf=mushaf, page_number__gte=first, page_number__lte=last).values(
        "page_number",
        "revision",
        "confirmed_revision",
        "payload__lines__0__snapshot_id",
    )
    return {
        row["page_number"]: {
            "revision": row["revision"],
            "confirmed_revision": row["confirmed_revision"],
            "drafted": row["payload__lines__0__snapshot_id"] is not None,
        }
        for row in rows
    }


def _decide(page: Page | None, numbered: bool, review: Doc | None, *, refresh: bool) -> str:
    """What the batch does to one page — see the module docstring. ``drafted`` is
    settled when the page is reached, by whether its sources are still current."""
    if page is None:
        return "missing"
    if not page.reviewed:
        return "not_reviewed"
    if not numbered:
        return "not_numbered"
    if review is None or not review["drafted"]:
        return "new"
    if review["confirmed_revision"] is not None:
        return "confirmed"
    return "refresh" if refresh else "drafted"


def _check_range(mushaf: Mushaf, first: int, last: int) -> None:
    count = mushaf.last_quran_pdf_page - mushaf.first_quran_pdf_page + 1
    if not 1 <= first <= last <= count:
        raise HttpError(422, i18n.t("page_range", count=count, start=first, end=last))


def plan(mushaf: Mushaf, first: int, last: int, *, refresh: bool = False) -> Doc:
    """What a batch over ``first``..``last`` would do, page by page. Stores nothing.

    ``pages`` lists the page numbers under each reason; ``process`` counts the pages
    sure to be processed, ``drafted`` the drafts processed again only if their
    sources changed. ``process_seconds`` is what a page has taken here lately.
    """
    _check_range(mushaf, first, last)
    pages = {
        page.page_number: page
        for page in Page.objects.filter(mushaf=mushaf, page_number__gte=first, page_number__lte=last).only(
            "page_number", "reviewed"
        )
    }
    numbered = _numbered(mushaf, first, last)
    reviews = _reviews(mushaf, first, last)
    found: dict[str, list[int]] = {}
    for number in range(first, last + 1):
        reason = _decide(pages.get(number), number in numbered, reviews.get(number), refresh=refresh)
        found.setdefault(reason, []).append(number)
    return {
        "first": first,
        "last": last,
        "refresh": refresh,
        "pages": found,
        "process": sum(len(found.get(reason, [])) for reason in PROCESS),
        "drafted": len(found.get("drafted", [])),
        "process_seconds": calibration_progress.cost(mushaf)["process_seconds"],
    }


def decide_batch_page_when_reached(mushaf: Mushaf, number: int, *, refresh: bool) -> tuple[str, int]:
    """Decide one page as the batch reaches it: the reason, and the draft revision it
    would be processed over."""
    page = Page.objects.filter(mushaf=mushaf, page_number=number).only("page_number", "reviewed").first()
    reviews = _reviews(mushaf, number, number)
    review = reviews.get(number)
    reason = _decide(page, number in _numbered(mushaf, number, number), review, refresh=refresh)
    revision = review["revision"] if review else 0
    if reason != "drafted":
        return reason, revision
    stored = CalibrationReview.objects.get(mushaf=mushaf, page_number=number)
    lines_current = calibration.are_line_snapshots_current(mushaf, stored.payload.get("lines", []))
    current = lines_current and calibration.are_context_lines_current(mushaf, stored.payload.get("context", []))
    return ("current" if current else "stale"), revision

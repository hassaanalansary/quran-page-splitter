"""Process many pages for calibration review in one job: *Process pages N to M*.

Page by page, every page waits about 45 seconds to be processed before it can be
reviewed. A batch processes a whole range in the background, one page after another,
and the pages are reviewed and confirmed afterwards in any order. The readiness meter
(:mod:`api.services.calibration_progress`) says when that stops costing anything.

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

import logging
import time
from typing import Any

from django.db.models import Count, Q
from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import (
    CalibrationReview,
    LineTypeChoices,
    Mushaf,
    Page,
    ProcessJob,
    ProcessJobKindChoices,
    ProcessJobStateChoices,
    Segment,
)
from api.services import calibration, calibration_progress, jobs

logger = logging.getLogger(__name__)

Doc = dict[str, Any]

#: Why a page is processed.
PROCESS = ("new", "refresh", "stale")
#: Why a page is left alone. ``drafted`` is only ever a plan's word: such a draft is
#: processed again when its sources changed (``stale``), and otherwise left (``current``).
SKIP = ("current", "confirmed", "not_reviewed", "not_numbered", "missing")


def _numbered(mushaf: Mushaf, first: int, last: int) -> set[int]:
    """The pages whose text lines' segments all carry an aya — the ones a span can be
    read for (``calibration._span_for_page`` refuses the rest)."""
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
        "experimental": calibration.settings_document(mushaf)["experimental"],
    }


def start(
    mushaf: Mushaf,
    first: int,
    last: int,
    *,
    refresh: bool = False,
    user: User | None = None,
    inline: bool | None = None,
) -> ProcessJob:
    """Start processing ``first``..``last`` as one background job. Refuses a range in
    which there is nothing it could process."""
    planned = plan(mushaf, first, last, refresh=refresh)
    if not planned["process"] and not planned["drafted"]:
        raise HttpError(422, i18n.t("calibration_batch_nothing", first=first, last=last))
    report: Doc = {
        "first": first,
        "last": last,
        "refresh": refresh,
        "planned": planned["process"],
        "processed": [],
        "skipped": {},
        "failed": [],
        "busy_seconds": 0.0,
    }
    return jobs.start_pages(
        mushaf,
        kind=ProcessJobKindChoices.CALIBRATION_BATCH,
        first_page=first,
        last_page=last,
        total=last - first + 1,
        runner=_runner(mushaf, refresh, user),
        user=user,
        inline=inline,
        report=report,
    )


def _reach(mushaf: Mushaf, number: int, *, refresh: bool) -> tuple[str, int]:
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
    current = calibration._sources_current(mushaf, stored.payload.get("lines", [])) and calibration._context_current(
        mushaf, stored.payload.get("context", [])
    )
    return ("current" if current else "stale"), revision


def _runner(mushaf: Mushaf, refresh: bool, user: User | None) -> Any:
    def run(job: ProcessJob) -> None:
        report: Doc = dict(job.report or {})
        cancelled = False
        for number in range(job.page_range_start, job.page_range_end + 1):
            # Settled under it means another run may hold the mushaf now: stop quietly.
            if jobs.is_settled(job.id):
                return
            if jobs.cancel_requested(job.id):
                cancelled = True
                break
            reason, revision = _reach(mushaf, number, refresh=refresh)
            if reason not in PROCESS:
                report["skipped"].setdefault(reason, []).append(number)
                jobs._touch(job.id, current_page=number, report=report)
                continue
            jobs._touch(job.id, current_page=number, phase="detecting", lines_done=0, report=report)
            began = time.monotonic()
            try:
                done = calibration.process_page(
                    mushaf,
                    number,
                    expected_revision=revision,
                    user=user,
                    progress=lambda count: jobs._touch(job.id, lines_done=count),
                    cancelled=lambda: jobs.cancel_requested(job.id),
                )
            except HttpError as refused:
                # Changed between deciding and storing: edited, re-reviewed, renumbered.
                report["failed"].append({"page": number, "error": str(refused)})
                jobs._touch(job.id, report=report)
                continue
            except Exception as failure:  # one page must not cost the rest of the range
                logger.exception("Calibration batch %s: page %s failed", job.id, number)
                report["failed"].append({"page": number, "error": str(failure) or failure.__class__.__name__})
                jobs._touch(job.id, report=report)
                continue
            if not done:
                cancelled = True
                break
            report["processed"].append(number)
            report["busy_seconds"] = round(report.get("busy_seconds", 0.0) + time.monotonic() - began, 1)
            logger.info("Calibration batch %s: page %s processed (%s)", job.id, number, reason)
            jobs._touch(job.id, pages_saved=len(report["processed"]), report=report)
        jobs.settle(
            job.id,
            ProcessJobStateChoices.CANCELLED if cancelled else ProcessJobStateChoices.COMPLETED,
            pages_saved=len(report["processed"]),
            report=report,
        )

    return run

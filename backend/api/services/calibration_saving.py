"""Storing a reviewer's work on a page: saving the draft, and confirming it.

Both read the reviewer's edits the same way::

    save_page_draft                         confirm_page
      read_reviewer_edits                     read_reviewer_edits
      (already landed? → the page as is)      (already landed? → the page as is)
                                              refuse_unacknowledged_exceptions
                                              write_confirmed_words
      bump_review_revision                    bump_review_revision
                                              record_confirmed_revision
                                              add_confirmed_page_to_library
      store_review_payload                    store_review_payload

**Idempotent per ``request_id``:** a retried request that already landed returns the
current state instead of applying twice, and a *different* request reusing the id is
refused.

**``realign``** is how a preview is accepted. The edits carry decisions, never the
engine's verdicts (a line's status, a blob's attention), so storing them as they came
would keep the verdicts of the reading *before* the preview. The page is read again
under the same edits instead. The search is deterministic, so what is stored is what
the preview showed.

Only a confirmation is a source of examples: it writes the page's words (the product)
and an immutable ``confirmed`` revision, and brings the page into the mushaf's stored
fingerprint set, in the same transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from django.db import transaction

from accounts.models import User
from api.models import (
    ActivityTypeChoices,
    CalibrationReview,
    CalibrationRevision,
    CalibrationRevisionKind,
    Mushaf,
    Page,
)
from api.services import activity, word_coordinates
from api.services import calibration_snapshots as snapshots
from api.services.calibration import (
    align_document,
    apply_edits_to_draft,
    apply_text_types_to_draft,
    build_revision_record,
    exceptions,
    page_document,
    refuse_if_context_lines_changed,
    refuse_request,
)
from api.services.fingerprint_updates import add_confirmed_page_to_library

Doc = dict[str, Any]


@dataclass
class ReviewerEdits:
    """A save or confirm request, read against the page it changes."""

    page_row: Page | None
    review: CalibrationReview
    document: Doc
    request: Doc
    already_landed: bool


@transaction.atomic
def save_page_draft(mushaf: Mushaf, page: int, data: Doc, *, user: User | None = None) -> Doc:
    """Store the reviewer's edits as the page's draft. Never a source of examples."""
    edits = read_reviewer_edits(mushaf, page, data, confirm=False)
    if edits.already_landed:
        return page_document(mushaf, page)
    bump_review_revision(edits)
    store_review_payload(mushaf, page, edits, activity_type=ActivityTypeChoices.CALIBRATION_SAVED, user=user)
    return page_document(mushaf, page)


@transaction.atomic
def confirm_page(mushaf: Mushaf, page: int, data: Doc, *, user: User | None = None) -> Doc:
    """Approve the whole page: its words become the product, its blobs examples.

    Counts that do not close are allowed, but only when acknowledged.
    """
    edits = read_reviewer_edits(mushaf, page, data, confirm=True)
    if edits.already_landed:
        return page_document(mushaf, page)
    refuse_unacknowledged_exceptions(edits.document, data)
    write_confirmed_words(edits)
    bump_review_revision(edits)
    revision = record_confirmed_revision(edits)
    add_confirmed_page_to_library(mushaf, page, revision)
    store_review_payload(mushaf, page, edits, activity_type=ActivityTypeChoices.CALIBRATION_CONFIRMED, user=user)
    return page_document(mushaf, page)


def read_reviewer_edits(mushaf: Mushaf, page: int, data: Doc, *, confirm: bool) -> ReviewerEdits:
    """Lock the page, then its review (always in this order, so two saves cannot
    deadlock), and read the request's edits onto the draft."""
    page_row = Page.objects.select_for_update().filter(mushaf=mushaf, page_number=page).first()
    review = CalibrationReview.objects.select_for_update().filter(mushaf=mushaf, page_number=page).first()
    if review is None or not review.payload.get("lines"):
        refuse_request("not_processed", 422, page=page)
    request = {"id": str(data["request_id"]), "hash": hash_save_request(data, confirm)}
    if has_request_landed(review, request):
        return ReviewerEdits(page_row, review, review.payload, request, already_landed=True)

    document = apply_edits_to_draft(mushaf, review, data)
    if data.get("realign"):
        refuse_if_context_lines_changed(mushaf, document)
        document = align_document(
            mushaf,
            document,
            affected_ayas=set(document.get("pending_ayas", [])),
            calibration_locks=True,
        )
        apply_text_types_to_draft(mushaf, document)
        document["pending_ayas"] = []
    return ReviewerEdits(page_row, review, document, request, already_landed=False)


def hash_save_request(data: Doc, confirm: bool) -> str:
    return snapshots.digest_json({"data": {k: v for k, v in data.items() if k != "request_id"}, "confirm": confirm})


def has_request_landed(review: CalibrationReview, request: Doc) -> bool:
    """Whether this request id already landed — refused when it landed with other edits."""
    landed = review.payload.get("request") or {}
    previous = CalibrationRevision.objects.filter(review=review, request_id=request["id"]).first()
    if previous is None and landed.get("id") != request["id"]:
        return False
    if (previous.payload.get("request_hash") if previous else landed.get("hash")) != request["hash"]:
        refuse_request("request_reused")
    return True


def refuse_unacknowledged_exceptions(document: Doc, data: Doc) -> None:
    found = exceptions(document)
    if found and not data.get("acknowledge_exceptions"):
        refuse_request("exceptions", 422, count=len(found))


def write_confirmed_words(edits: ReviewerEdits) -> None:
    """The page's words, the product the exports read."""
    if edits.page_row is None:
        refuse_request("stale_source")
    word_coordinates.replace_page_words(
        edits.page_row,
        [
            {
                "line_id": uuid.UUID(row["line_id"]),
                "words": [{key: word[key] for key in ("word_id", "start_x", "end_x")} for word in row["words"]],
            }
            for row in edits.document["lines"]
        ],
    )


def bump_review_revision(edits: ReviewerEdits) -> None:
    edits.review.revision += 1
    edits.document["request"] = edits.request


def record_confirmed_revision(edits: ReviewerEdits) -> CalibrationRevision:
    """The immutable ``confirmed`` revision: the only thing examples come from."""
    review = edits.review
    review.confirmed_revision = review.revision
    return CalibrationRevision.objects.create(
        review=review,
        number=review.revision,
        kind=CalibrationRevisionKind.CONFIRMED,
        payload={
            **build_revision_record(edits.document),
            "request_hash": edits.request["hash"],
            "acknowledged": exceptions(edits.document),
        },
        request_id=edits.request["id"],
    )


def store_review_payload(
    mushaf: Mushaf, page: int, edits: ReviewerEdits, *, activity_type: str, user: User | None
) -> None:
    review = edits.review
    review.payload = edits.document
    review.save(update_fields=["revision", "confirmed_revision", "payload", "updated_at"])
    activity.emit(mushaf, activity_type, {"page_number": page, "revision": review.revision}, actor=user)

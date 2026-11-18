"""Examples: what the fingerprint library is built from.

Every blob on a confirmed page that may teach the library body-versus-mark, and a
mark's type, read from the page's confirmed revision (never a draft) with its
descriptor from the line's snapshot.
"""

from __future__ import annotations

from typing import Any

from django.db.models import F

from api.models import CalibrationReview, CalibrationRevision, CalibrationRevisionKind, CalibrationSnapshot, Mushaf
from api.services import calibration_snapshots as snapshots

Doc = dict[str, Any]

TEXT_ROLES = ("body", "mark")
#: Which version of the grouping and the eligibility rules a stored fingerprint set
#: was built by: a set built by another is regrouped at its first use.
LIBRARY_VERSION = 1


def find_confirmed_revision_of_review(review: CalibrationReview) -> CalibrationRevision | None:
    """The immutable revision a review's confirmation points at, if it has one."""
    if review.confirmed_revision is None:
        return None
    return CalibrationRevision.objects.filter(
        review=review, number=review.confirmed_revision, kind=CalibrationRevisionKind.CONFIRMED
    ).first()


def find_confirmed_revisions(mushaf: Mushaf) -> list[CalibrationRevision]:
    """Every page's confirmed approval, in page order — every page reads the one set,
    its own examples included: a fingerprint is just an example of a shape.

    One query, and **without payloads**: a confirmation's payload is its page's whole
    draft, and most callers only need to know *which* approvals there are (26 confirmed
    pages cost 1.3 s of JSON read whole). Where the examples themselves are needed,
    :func:`load_revision_payloads` reads them.
    """
    return list(
        CalibrationRevision.objects.filter(
            review__mushaf=mushaf,
            review__confirmed_revision__isnull=False,
            kind=CalibrationRevisionKind.CONFIRMED,
            number=F("review__confirmed_revision"),
        )
        .select_related("review")
        .defer("payload", "review__payload")
        .order_by("review__page_number")
    )


def load_revision_payloads(approved: list[CalibrationRevision]) -> list[CalibrationRevision]:
    """The same approvals, in the same order, read with their payloads — for the few
    places that need the examples themselves, and only when nothing is cached."""
    loaded = CalibrationRevision.objects.filter(pk__in=[revision.pk for revision in approved])
    by_pk = {revision.pk: revision for revision in loaded.select_related("review").defer("review__payload")}
    return [by_pk[revision.pk] for revision in approved if revision.pk in by_pk]


def is_blob_eligible_for_library(blob: Doc) -> bool:
    """Whether a confirmed blob may teach the matcher body-versus-mark.

    Not ornaments or symbols — they are structure, not text. Not anything flagged
    as an exception, nor ink a person erased. And not a body standing for other than
    exactly one PAW: a broken fragment (0) or fused pair (2) is letter ink whose
    *count* is unusual, and teaching its shape as an ordinary body would teach the
    wrong thing.
    """
    if blob["role"] not in TEXT_ROLES or blob.get("exception") or blob.get("erased"):
        return False
    if blob["role"] == "body" and blob.get("allocations"):
        return bool(sum(allocation["paws"] for allocation in blob["allocations"]) == 1)
    return True


def collect_library_examples(mushaf: Mushaf, revisions: list[CalibrationRevision]) -> list[dict]:
    ids = {line["snapshot_id"] for revision in revisions for line in revision.payload.get("lines", [])}
    stored = {str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=ids)}
    samples = []
    for revision in revisions:
        for line in revision.payload.get("lines", []):
            snapshot = stored.get(line["snapshot_id"])
            if snapshot is None:
                continue
            features = snapshots.blob_features(snapshot)
            for blob in line["blobs"]:
                if not is_blob_eligible_for_library(blob) or blob["id"] not in features:
                    continue
                samples.append(
                    {
                        "sample_id": f"{revision.pk}:{snapshot.pk}:{blob['id']}",
                        "snapshot_id": str(snapshot.pk),
                        "blob_id": blob["id"],
                        "page_number": snapshot.page_number,
                        "line_number": snapshot.line_number,
                        "role": blob["role"],
                        "subtype": blob["subtype"] if is_mark_typed(blob) else "",
                        "revision_id": str(revision.pk),
                        "features": features[blob["id"]],
                    }
                )
    return samples


def is_mark_typed(blob: Doc) -> bool:
    """A mark a person gave a type to — the only kind that may teach a type.

    A type with no ``subtype_explicit`` predates the flag, and every type then was
    set by hand. A type the text set (``subtype_source`` "text") counts as typed: the
    text named that mark, and a person confirms the page it is on. Flagged ink and
    erased ink teach nothing, as for roles.
    """
    return (
        blob["role"] == "mark"
        and bool(blob.get("subtype"))
        and (bool(blob.get("subtype_explicit", True)) or blob.get("subtype_source") == "text")
        and not blob.get("exception")
        and not blob.get("erased")
    )

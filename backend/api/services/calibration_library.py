"""The fingerprint set, laid out for a person to look through: Ink's Library mode.

The mushaf's one stored fingerprint set (:mod:`api.services.fingerprint_store`) is what
answers for every blob — body or mark, and which type — on every page. This shows it::

    Library v63 · 27 confirmed pages     the set's version, and the pages it holds
      fatha · 4 fingerprints             each fingerprint and the shapes kept beside it
      …
      letters · K                        smallest ink first: a mark learned as a letter is small
      Removed (n)                        what a person took out, to restore

and, for one blob selected on the page, how far it is from every kept shape and what
the set answers for it (:func:`compare_blob_with_library`).

**Every page sees the same set**, its own shapes included. A LIMIT may be *previewed*:
the set regrouped at it from every confirmed page, shown, and nothing saved. Applying
it is the settings' own save, which starts a Rebuild.

**The levers** (:mod:`api.services.fingerprint_updates`): Remove takes a badly printed
example out, Restore puts it back, Looks right keeps a shape whatever comes later. A
wrong *label* is fixed on its page ("open its source"), because the export reads the
page; the page's re-confirm updates the set.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from api.models import (
    CalibrationRevision,
    CalibrationSnapshot,
    FingerprintLibrary,
    FingerprintShape,
    Mushaf,
    ProcessJobKindChoices,
    RemovedShape,
)
from api.services import calibration
from api.services import calibration_snapshots as snapshots
from api.services.calibration_errors import refuse_request
from api.services.calibration_examples import find_confirmed_revisions, is_mark_typed
from api.services.calibration_settings import serialize_calibration_settings
from api.services.fingerprint_rebuild import build_preview_library
from api.services.fingerprint_store import load_current_library, load_current_set, read_library_record
from api.services.jobs.queries import find_active_job_of_mushaf
from core.word_boundary.library import Library

Doc = dict[str, Any]


def choose_library_to_show(mushaf: Mushaf, limit: float | None) -> Library:
    """The set — or, with ``limit``, the one every confirmed page would make at it."""
    return load_current_library(mushaf) if limit is None else build_preview_library(mushaf, limit)


def blob_key_of(ref: Doc) -> str:
    return f"{ref['snapshot_id']}:{ref['blob_id']}"


def group_id_of(item: Doc) -> str:
    return f"{item['role']}:{item['subtype']}:{blob_key_of(item['centre'])}"


def load_looks_right_keys(library_row: FingerprintLibrary) -> set[tuple[str, int]]:
    return {
        (str(snapshot_id), int(blob_id))
        for snapshot_id, blob_id in FingerprintShape.objects.filter(library=library_row, looks_right=True).values_list(
            "snapshot_id", "blob_id"
        )
    }


def is_library_rebuilding(mushaf: Mushaf) -> bool:
    job = find_active_job_of_mushaf(mushaf.id)
    return job is not None and job.kind == ProcessJobKindChoices.LIBRARY_REBUILD


class ShapeImages:
    """Refs made into what the view draws: where the blob is, its crop of its line's
    image, when its page was confirmed, and whether someone found it right."""

    def __init__(self, mushaf: Mushaf, refs: list[Doc], looks_right: set[tuple[str, int]]) -> None:
        ids = {ref["snapshot_id"] for ref in refs}
        self.stored = {str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=ids)}
        self.raw = {key: {blob["label"]: blob for blob in s.metadata["blobs"]} for key, s in self.stored.items()}
        revisions = {ref["revision_id"] for ref in refs if ref.get("revision_id")}
        self.confirmed = {
            str(revision.pk): revision.created_at for revision in CalibrationRevision.objects.filter(pk__in=revisions)
        }
        self.looks_right = looks_right

    def describe_shape(self, ref: Doc) -> Doc | None:
        source = self.stored.get(ref["snapshot_id"])
        raw = self.raw.get(ref["snapshot_id"], {}).get(ref["blob_id"])
        if source is None or raw is None:
            return None
        confirmed = self.confirmed.get(ref.get("revision_id") or "")
        return {
            "key": blob_key_of(ref),
            "snapshot_id": ref["snapshot_id"],
            "blob_id": ref["blob_id"],
            "page_number": source.page_number,
            "line_number": source.line_number,
            "image_url": source.image.url,
            # The line image's own size, so the view can lay it out before it loads.
            "image_size": {"w": source.metadata["bbox"]["w"], "h": source.metadata["bbox"]["h"]},
            "crop": {
                "x": raw["x"] + source.metadata["offset_x"],
                "y": raw["y"] + source.metadata["offset_y"],
                "w": raw["w"],
                "h": raw["h"],
            },
            "area": raw["area"],
            "confirmed_at": confirmed.isoformat() if confirmed else None,
            "looks_right": (str(ref["snapshot_id"]), int(ref["blob_id"])) in self.looks_right,
        }


def order_groups_for_audit(groups: list[Doc], role: str) -> list[Doc]:
    """A mark type's groups as a person audits them: the groups of one first, then the
    ones reaching farthest, then the fullest. Letters smallest ink first."""
    if role == "body":
        return sorted(groups, key=lambda item: (item["fingerprint"]["area"], -len(item["kept"])))
    return sorted(groups, key=lambda item: (bool(item["kept"]), -item["farthest"], -len(item["kept"])))


def serialize_library_view(mushaf: Mushaf, page: int, *, limit: float | None = None) -> Doc:
    """The set, kind by kind — or, with ``limit``, the one it would be at that LIMIT,
    built for the asking and saved nowhere."""
    settings = serialize_calibration_settings(mushaf)
    current = load_current_set(mushaf)
    library = current.library if limit is None else build_preview_library(mushaf, limit)
    review = calibration.find_review_of_page(mushaf, page)
    draft = read_library_record(review.payload) if review and review.payload.get("lines") else None
    removals = list(RemovedShape.objects.filter(mushaf=mushaf).order_by("created_at"))
    refs = [ref for item in library.groups for ref in (item["centre"], *(item["members"][i] for i in item["kept"]))]
    refs += [{"snapshot_id": str(removal.snapshot_id), "blob_id": removal.blob_id} for removal in removals]
    shapes = ShapeImages(mushaf, refs, load_looks_right_keys(current.library_row))

    kinds: dict[tuple[str, str], list[Doc]] = {}
    for item in library.groups:
        fingerprint = shapes.describe_shape(item["centre"])
        if fingerprint is None:
            continue
        kept = []
        for index in item["kept"]:
            shape = shapes.describe_shape(item["members"][index])
            if shape is not None:
                kept.append({**shape, "distance": round(item["distance"][index], 4)})
        kinds.setdefault((item["role"], item["subtype"]), []).append(
            {
                "id": group_id_of(item),
                "farthest": round(max((item["distance"][index] for index in item["kept"]), default=0.0), 4),
                "fingerprint": fingerprint,
                "kept": kept,
            }
        )
    removed = []
    for removal in removals:
        shape = shapes.describe_shape({"snapshot_id": str(removal.snapshot_id), "blob_id": removal.blob_id})
        if shape is not None:
            removed.append({**shape, "role": removal.role, "subtype": removal.subtype})
    # Typed marks by how much they keep, then the untyped marks, then the letters.
    order = sorted(
        kinds,
        key=lambda kind: (
            kind[0] == "body",
            kind[1] == "",
            -sum(1 + len(group["kept"]) for group in kinds[kind]),
            kind[1],
        ),
    )
    return {
        "page": page,
        "preview": limit is not None,
        "limit": library.limit,
        "saved_limit": settings["limit"],
        "default_limit": settings["default_limit"],
        "comparison": settings["comparison"],
        "version": current.library_row.version,
        "pages": [revision.review.page_number for revision in find_confirmed_revisions(mushaf)],
        # The set's version the page's draft was read with, when it was processed.
        "draft_version": draft["version"] if draft else None,
        "needs_rebuild": current.library_row.needs_rebuild,
        "rebuilding": is_library_rebuilding(mushaf),
        "fingerprints": library.fingerprints,
        "removed": removed,
        "kinds": [
            {"role": role, "subtype": subtype, "groups": order_groups_for_audit(kinds[(role, subtype)], role)}
            for role, subtype in order
        ],
    }


def compare_blob_with_library(mushaf: Mushaf, page: int, data: Doc) -> Doc:
    """One blob of the page against the library: what it answers — body or mark from
    the nearest letter and the nearest mark, and a mark's type and its runner-up — and
    the blob's distance to every kept shape, so the view can sort each type by it.

    From the draft as the editor holds it, so typing not yet saved counts: an untyped
    mark is asked of the library *and* the marks typed on this page, as its guess is
    (``own`` counts them). A typed one is asked of the set alone — the question its
    doubt asks. The set holds every confirmed page, this one's too: a typed mark that
    is itself a kept shape finds itself (decided 2026-11-18; Library mode's review is
    that check).
    """
    review = calibration.find_review_of_page(mushaf, page)
    if review is None or not review.payload.get("lines"):
        refuse_request("not_processed", 422, page=page)
    rows = calibration.apply_edits_to_draft(mushaf, review, data)["lines"]
    row = next((row for row in rows if row["snapshot_id"] == data["snapshot_id"]), None)
    blob = next((blob for blob in (row["blobs"] if row else []) if blob["id"] == data["blob_id"]), None)
    snapshot = CalibrationSnapshot.objects.filter(mushaf=mushaf, pk=data["snapshot_id"]).first()
    features = snapshots.blob_features(snapshot).get(data["blob_id"]) if snapshot else None
    if blob is None or features is None:
        refuse_request("not_found", 404, page=page)

    library = choose_library_to_show(mushaf, data.get("limit"))
    found = library.role_of(features)
    answer = (
        {
            "role": found["role"],
            "confidence": found["confidence"],
            "nearest_letter": found["nearest_letter"],
            "nearest_mark": found["nearest_mark"],
            "letter": blob_key_of(found["letter"]),
            "mark": blob_key_of(found["mark"]),
        }
        if found["role"] is not None
        else None
    )
    row_distances = library.measure_distances([features])[0] if library.refs else np.zeros(0)
    distances = {blob_key_of(ref): round(float(row_distances[i]), 4) for i, ref in enumerate(library.refs)}

    stored = {str(snapshot.pk): snapshot}
    stored.update(
        {
            str(s.pk): s
            for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[r["snapshot_id"] for r in rows])
        }
    )
    typed = is_mark_typed(blob)
    own_samples = [
        sample
        for sample in calibration.collect_typed_marks_of_draft(stored, rows)
        if (sample["snapshot_id"], sample["blob_id"]) != (data["snapshot_id"], data["blob_id"])
    ]
    kind = None
    if blob["role"] == "mark":
        index = library if typed else library.with_typed(own_samples)
        guess = index.predict_types([features])[0]
        if guess["subtype"]:
            kind = {key: guess[key] for key in ("subtype", "distance", "sure", "runner_up", "runner_distance")}

    return {
        "snapshot_id": data["snapshot_id"],
        "blob_id": data["blob_id"],
        "role": blob["role"],
        "subtype": blob.get("subtype", ""),
        "typed": typed,
        "answer": answer,
        "type": kind,
        "distances": distances,
        # How many marks typed on this page took part in the guess: none for a typed mark.
        "own": len(own_samples) if blob["role"] == "mark" and not typed else 0,
    }

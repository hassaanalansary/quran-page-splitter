"""The fingerprint library, laid out for a person to look through: Ink's Library mode.

The library (:mod:`core.word_boundary.library`) is what answers for every blob — body
or mark, and which type. This shows it::

    as page N sees it          every confirmed page but N, grouped kind by kind
      fatha · 20 fingerprints    each fingerprint, its count, the members kept beside it
      …
      letters · K                smallest ink first: a mark learned as a letter is small

and, for one blob selected on the page, how far it is from every kept shape and what
the library answers for it (:func:`compare`).

**Always the library that answers for the page on screen** — page N's never holds N's
own labels, as for processing. A LIMIT may be *previewed*: the library rebuilt at it,
shown, and nothing saved. Applying it is the settings' own save.

**Nothing here is a lever on the library.** A fingerprint that is wrong is a wrong
label on its page, fixed there; the only thing stored is a person's "looks right" on an
example blob (:class:`api.models.LibraryCheck`), which counts while the blob is still
confirmed as what it was when it was looked at.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

import numpy as np

from api.models import CalibrationRevision, CalibrationSnapshot, LibraryCheck, Mushaf
from api.services import calibration
from api.services import calibration_snapshots as snapshots
from core.word_boundary.library import Library, build_library, comparison

Doc = dict[str, Any]

#: Members listed per request when a person asks for all of a group's.
MEMBERS_PAGE = 60

#: The last previewed library, so a preview's comparisons do not rebuild it for every
#: blob asked about. One slot, beside the processing cache rather than in it: a preview
#: never takes the place of a library a page was processed with.
_PREVIEW: OrderedDict[tuple, Library] = OrderedDict()


def _preview(mushaf: Mushaf, page: int, limit: float) -> Library:
    if not 0 < limit <= calibration.LIMIT_CEILING:
        calibration._refuse("invalid_edits", 422)
    approved = calibration._approved(mushaf, page)
    method = comparison(calibration.settings_document(mushaf)["comparison"])
    key = (str(mushaf.pk), tuple(str(revision.pk) for revision in approved), method.name, limit)
    library = _PREVIEW.get(key)
    if library is None:
        _PREVIEW.clear()
        library = _PREVIEW[key] = build_library(calibration._samples(mushaf, approved), method=method, limit=limit)
    return library


def _library(mushaf: Mushaf, page: int, limit: float | None) -> Library:
    """The library for ``page`` — at ``limit`` when one is previewed."""
    return calibration._library(mushaf, page) if limit is None else _preview(mushaf, page, limit)


def _key(ref: Doc) -> str:
    return f"{ref['snapshot_id']}:{ref['blob_id']}"


def _group_id(item: Doc) -> str:
    return f"{item['role']}:{item['subtype']}:{_key(item['centre'])}"


class _Shapes:
    """Refs made into what the view draws: where the blob is, its crop of its line's
    image, when its page was confirmed, and whether someone found it right."""

    def __init__(self, mushaf: Mushaf, refs: list[Doc]) -> None:
        ids = {ref["snapshot_id"] for ref in refs}
        self.stored = {str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=ids)}
        self.raw = {key: {blob["label"]: blob for blob in s.metadata["blobs"]} for key, s in self.stored.items()}
        revisions = {ref["revision_id"] for ref in refs if ref.get("revision_id")}
        self.confirmed = {
            str(revision.pk): revision.created_at for revision in CalibrationRevision.objects.filter(pk__in=revisions)
        }
        self.checks = {
            (str(check.snapshot_id), check.blob_id): check
            for check in LibraryCheck.objects.filter(mushaf=mushaf, snapshot_id__in=ids)
        }

    def of(self, ref: Doc, role: str, subtype: str) -> Doc | None:
        source = self.stored.get(ref["snapshot_id"])
        raw = self.raw.get(ref["snapshot_id"], {}).get(ref["blob_id"])
        if source is None or raw is None:
            return None
        check = self.checks.get((ref["snapshot_id"], ref["blob_id"]))
        confirmed = self.confirmed.get(ref.get("revision_id") or "")
        return {
            "key": _key(ref),
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
            "looks_right": check is not None and (check.role, check.subtype) == (role, subtype),
        }


def _ordered(groups: list[Doc], role: str) -> list[Doc]:
    """A mark type's groups as a person audits them: the groups of one first, then the
    ones reaching farthest, then the rest by size. Letters smallest ink first."""
    if role == "body":
        return sorted(groups, key=lambda item: (item["fingerprint"]["area"], -item["count"]))
    return sorted(groups, key=lambda item: (item["count"] != 1, -item["farthest"], -item["count"]))


def library_document(mushaf: Mushaf, page: int, *, limit: float | None = None) -> Doc:
    """The library that answers for ``page``, kind by kind — or, with ``limit``, the
    one it would be at that LIMIT, built for the asking and saved nowhere."""
    settings = calibration.settings_document(mushaf)
    approved = calibration._approved(mushaf, page)
    library = _library(mushaf, page, limit)
    review = calibration._review(mushaf, page)
    profile = (review.payload.get("profile") or {}) if review and review.payload.get("lines") else {}
    shapes = _Shapes(
        mushaf,
        [ref for item in library.groups for ref in (item["centre"], *(item["members"][i] for i in item["kept"]))],
    )

    kinds: dict[tuple[str, str], list[Doc]] = {}
    for item in library.groups:
        fingerprint = shapes.of(item["centre"], item["role"], item["subtype"])
        if fingerprint is None:
            continue
        kept = []
        for index in item["kept"]:
            shape = shapes.of(item["members"][index], item["role"], item["subtype"])
            if shape is not None:
                kept.append({**shape, "distance": round(item["distance"][index], 4)})
        kinds.setdefault((item["role"], item["subtype"]), []).append(
            {
                "id": _group_id(item),
                "count": len(item["members"]),
                "farthest": round(item["distance"][-1], 4),
                "fingerprint": fingerprint,
                "kept": kept,
            }
        )
    # Typed marks by how much they hold, then the untyped marks, then the letters.
    order = sorted(
        kinds,
        key=lambda kind: (kind[0] == "body", kind[1] == "", -sum(group["count"] for group in kinds[kind]), kind[1]),
    )
    return {
        "page": page,
        "preview": limit is not None,
        "limit": library.limit,
        "saved_limit": settings["limit"],
        "default_limit": settings["default_limit"],
        "comparison": settings["comparison"],
        "pages": [revision.review.page_number for revision in approved],
        # The page's own confirmation is not in its library.
        "left_out": page if review is not None and review.confirmed_revision is not None else None,
        # What the page's draft was read with, when it was processed from other pages.
        "draft_pages": profile.get("pages"),
        "examples": library.examples,
        "fingerprints": library.fingerprints,
        "kinds": [
            {
                "role": role,
                "subtype": subtype,
                "examples": sum(group["count"] for group in kinds[(role, subtype)]),
                "groups": _ordered(kinds[(role, subtype)], role),
            }
            for role, subtype in order
        ],
    }


def library_members(
    mushaf: Mushaf, page: int, group: str, *, offset: int = 0, count: int = MEMBERS_PAGE, limit: float | None = None
) -> Doc:
    """Every member of one group, the farthest from its fingerprint first, a page of
    them at a time."""
    library = _library(mushaf, page, limit)
    item = next((item for item in library.groups if _group_id(item) == group), None)
    if item is None:
        calibration._refuse("not_found", 404, page=page)
    order = list(range(len(item["members"])))[::-1]
    window = order[max(0, offset) : max(0, offset) + max(1, min(count, MEMBERS_PAGE))]
    shapes = _Shapes(mushaf, [item["members"][index] for index in window])
    members = []
    for index in window:
        shape = shapes.of(item["members"][index], item["role"], item["subtype"])
        if shape is not None:
            members.append({**shape, "distance": round(item["distance"][index], 4)})
    return {"group": group, "total": len(item["members"]), "offset": offset, "members": members}


def compare(mushaf: Mushaf, page: int, data: Doc) -> Doc:
    """One blob of the page against the library: what it answers — body or mark from
    the nearest letter and the nearest mark, and a mark's type and its runner-up — and
    the blob's distance to every kept shape, so the view can sort each type by it.

    From the draft as the editor holds it, so typing not yet saved counts: an untyped
    mark is asked of the library *and* the marks typed on this page, as its guess is
    (``own``, a row of its own: they are not confirmed). A typed one is asked of the
    other pages only — the question its doubt asks.
    """
    review = calibration._review(mushaf, page)
    if review is None or not review.payload.get("lines"):
        calibration._refuse("not_processed", 422, page=page)
    rows = calibration._apply_edits(mushaf, review, data)["lines"]
    row = next((row for row in rows if row["snapshot_id"] == data["snapshot_id"]), None)
    blob = next((blob for blob in (row["blobs"] if row else []) if blob["id"] == data["blob_id"]), None)
    snapshot = CalibrationSnapshot.objects.filter(mushaf=mushaf, pk=data["snapshot_id"]).first()
    features = snapshots.blob_features(snapshot).get(data["blob_id"]) if snapshot else None
    if blob is None or features is None:
        calibration._refuse("not_found", 404, page=page)

    library = _library(mushaf, page, data.get("limit"))
    found = library.role_of(features)
    answer = (
        {
            "role": found["role"],
            "confidence": found["confidence"],
            "nearest_letter": found["nearest_letter"],
            "nearest_mark": found["nearest_mark"],
            "letter": _key(found["letter"]),
            "mark": _key(found["mark"]),
        }
        if found["role"] is not None
        else None
    )
    row_distances = library._distances([features])[0] if library.refs else np.zeros(0)
    distances = {_key(ref): round(float(row_distances[i]), 4) for i, ref in enumerate(library.refs)}

    stored = {str(snapshot.pk): snapshot}
    stored.update(
        {
            str(s.pk): s
            for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[r["snapshot_id"] for r in rows])
        }
    )
    typed = calibration._typed(blob)
    own_samples = [
        sample
        for sample in calibration._typed_samples(stored, rows)
        if (sample["snapshot_id"], sample["blob_id"]) != (data["snapshot_id"], data["blob_id"])
    ]
    kind = None
    if blob["role"] == "mark":
        index = library if typed else library.with_typed(own_samples)
        guess = index.predict_types([features])[0]
        if guess["subtype"]:
            kind = {key: guess[key] for key in ("subtype", "distance", "sure", "runner_up", "runner_distance")}

    own = []
    if own_samples:
        method = library.method
        near = method.distances(
            method.stack([method.describe(sample["features"]) for sample in own_samples]), [method.describe(features)]
        )[0]
        shapes = _Shapes(mushaf, own_samples)
        for sample, distance in zip(own_samples, near, strict=True):
            shape = shapes.of(sample, "mark", sample["subtype"])
            if shape is not None:
                own.append({**shape, "subtype": sample["subtype"], "distance": round(float(distance), 4)})
        own.sort(key=lambda entry: (entry["distance"], entry["subtype"]))

    return {
        "snapshot_id": data["snapshot_id"],
        "blob_id": data["blob_id"],
        "role": blob["role"],
        "subtype": blob.get("subtype", ""),
        "typed": typed,
        "answer": answer,
        "type": kind,
        "distances": distances,
        "own": own,
    }


def set_check(mushaf: Mushaf, data: Doc) -> Doc:
    """Say an example looks right, as the role and type it is confirmed as now."""
    snapshot = CalibrationSnapshot.objects.filter(mushaf=mushaf, pk=data["snapshot_id"]).first()
    if snapshot is None or data["role"] not in calibration.TEXT_ROLES:
        calibration._refuse("not_found", 404, page=data.get("page", 0))
    LibraryCheck.objects.update_or_create(
        mushaf=mushaf,
        snapshot=snapshot,
        blob_id=data["blob_id"],
        defaults={"role": data["role"], "subtype": data.get("subtype") or ""},
    )
    return {"snapshot_id": str(snapshot.pk), "blob_id": data["blob_id"], "looks_right": True}


def clear_check(mushaf: Mushaf, snapshot_id: str, blob_id: int) -> Doc:
    LibraryCheck.objects.filter(mushaf=mushaf, snapshot_id=snapshot_id, blob_id=blob_id).delete()
    return {"snapshot_id": snapshot_id, "blob_id": blob_id, "looks_right": False}

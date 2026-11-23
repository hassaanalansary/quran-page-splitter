"""The stored fingerprint set carried by a copy and by a bundle.

A copy or an import carries **the set itself**: its groups, its kept shapes (snapshot and
revision ids remapped to the target's), the looks-right marks and the removed list. The
target starts with identical fingerprints, and can Rebuild at any time.

- **Features:** a bundle does not carry them (they are 8 KB a shape, and the bundled
  line images measure them again); a copy, made in-process, hands them over as they
  are, so duplicating a mushaf measures nothing.
- **A target with confirmed pages of its own** keeps no set at all after an import: the
  pages it ends up with are its own plus the bundle's, which neither set describes, so
  its set is built from all of them at the next lookup. So is an old bundle's target:
  bundles from before the stored set carry no set.
"""

from __future__ import annotations

import uuid
from typing import Any

import numpy as np
from django.db import transaction

from api.models import CalibrationSnapshot, FingerprintLibrary, Mushaf, RemovedShape
from api.services import calibration_snapshots as snapshots
from api.services.fingerprint_rows import (
    find_fingerprint_library,
    load_stored_groups,
    lock_fingerprint_library,
    replace_stored_groups,
)
from core.word_boundary.library_updates import KeptShape, ShapeGroup

Doc = dict[str, Any]


def serialize_fingerprint_set(mushaf: Mushaf, *, with_features: bool = False) -> Doc | None:
    """The set as plain data, or None when the mushaf has none."""
    library_row = find_fingerprint_library(mushaf)
    if library_row is None or not library_row.version:
        return None
    groups = load_stored_groups(library_row).groups
    return {
        "version": library_row.version,
        "comparison": library_row.comparison,
        "limit": library_row.limit,
        "feature_version": library_row.feature_version,
        "library_version": library_row.library_version,
        "needs_rebuild": library_row.needs_rebuild,
        "groups": [
            {
                "role": group.role,
                "key": group.key,
                "shapes": [serialize_shape(shape, with_features=with_features) for shape in group.shapes()],
            }
            for group in groups
        ],
        "removed": [
            {"snapshot_id": str(snapshot_id), "blob_id": blob_id, "role": role, "key": key}
            for snapshot_id, blob_id, role, key in RemovedShape.objects.filter(mushaf=mushaf)
            .order_by("snapshot_id", "blob_id")
            .values_list("snapshot_id", "blob_id", "role", "key")
        ],
    }


def serialize_shape(shape: KeptShape, *, with_features: bool) -> Doc:
    found: Doc = {
        "snapshot_id": shape.snapshot_id,
        "blob_id": shape.blob_id,
        "page_number": shape.page_number,
        "line_number": shape.line_number,
        "revision_id": shape.revision_id,
        "distance": shape.distance,
        "looks_right": shape.looks_right,
    }
    if with_features:
        found["features"] = shape.features
    return found


@transaction.atomic
def restore_fingerprint_set(
    target: Mushaf, data: Doc | None, ids: dict[str, str], *, had_confirmed_pages: bool
) -> None:
    """Put a carried set on ``target``, its ids remapped through ``ids`` (source id →
    target id, for snapshots and revisions alike) — or, when the target had confirmed
    pages of its own or the bundle carries no set, leave the target without one, to be
    built from all its confirmed pages at the next lookup."""
    if data is None or had_confirmed_pages:
        FingerprintLibrary.objects.filter(mushaf=target).delete()
        if data is not None:
            restore_removed_shapes(target, data, ids)
        return
    groups = [restore_group(target, entry, ids) for entry in data.get("groups", [])]
    library_row = lock_fingerprint_library(target, comparison_name=data["comparison"], limit=data["limit"])
    replace_stored_groups(library_row, [group for group in groups if group is not None])
    library_row.comparison = data["comparison"]
    library_row.limit = data["limit"]
    library_row.feature_version = data["feature_version"]
    library_row.library_version = data["library_version"]
    library_row.needs_rebuild = bool(data.get("needs_rebuild"))
    library_row.version = max(library_row.version, 0) + 1
    library_row.save()
    restore_removed_shapes(target, data, ids)


def restore_group(target: Mushaf, entry: Doc, ids: dict[str, str]) -> ShapeGroup | None:
    shapes = [shape for item in entry.get("shapes", []) if (shape := restore_shape(target, item, ids)) is not None]
    if not shapes:
        return None
    return ShapeGroup(role=entry["role"], key=entry["key"], fingerprint=shapes[0], kept=shapes[1:])


def restore_shape(target: Mushaf, item: Doc, ids: dict[str, str]) -> KeptShape | None:
    snapshot_id = ids.get(str(item["snapshot_id"]))
    if snapshot_id is None:
        return None
    features = item.get("features")
    if features is None:
        features = measure_restored_blob(target, snapshot_id, int(item["blob_id"]))
        if features is None:
            return None
    revision_id = item.get("revision_id")
    return KeptShape(
        snapshot_id=snapshot_id,
        blob_id=int(item["blob_id"]),
        page_number=int(item.get("page_number") or 0),
        line_number=int(item.get("line_number") or 0),
        revision_id=ids.get(str(revision_id)) if revision_id else None,
        features=np.asarray(features, dtype=np.float64),
        distance=float(item.get("distance") or 0.0),
        looks_right=bool(item.get("looks_right")),
    )


def measure_restored_blob(target: Mushaf, snapshot_id: str, blob_id: int) -> np.ndarray | None:
    """A carried shape's features, measured from the target's copy of its line. A blob
    that cannot be measured is left out of the set; a Rebuild refills its group."""
    snapshot = CalibrationSnapshot.objects.filter(mushaf=target, pk=snapshot_id).first()
    if snapshot is None:
        return None
    try:
        return snapshots.blob_features(snapshot).get(blob_id)
    except (KeyError, ValueError, OSError):
        return None


def restore_removed_shapes(target: Mushaf, data: Doc, ids: dict[str, str]) -> None:
    for item in data.get("removed", []):
        snapshot_id = ids.get(str(item["snapshot_id"]))
        if snapshot_id is None:
            continue
        RemovedShape.objects.update_or_create(
            mushaf=target,
            snapshot_id=uuid.UUID(snapshot_id),
            blob_id=int(item["blob_id"]),
            defaults={"role": item["role"], "key": item.get("key") or ""},
        )

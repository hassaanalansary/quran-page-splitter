"""The stored fingerprint set's rows, read as groups and written back.

A mushaf has one :class:`FingerprintLibrary` row (the set's version and settings), its
:class:`FingerprintGroup` rows, and a :class:`FingerprintShape` per kept shape, the
blob's raw features included. Here they become the pure ``ShapeGroup``s of
:mod:`core.word_boundary.library_updates` and go back again; the rules for changing the
groups live there, not here.

**Written as a difference.** A Confirm changes a handful of shapes out of ~2,400, so
:func:`save_stored_groups` compares the groups with the rows they were loaded from and
writes only what changed. A Rebuild replaces everything (:func:`replace_stored_groups`).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from api.models import FingerprintGroup, FingerprintLibrary, FingerprintShape, Mushaf, RemovedShape
from core.word_boundary.library import Comparison, comparison
from core.word_boundary.library_updates import KeptShape, ShapeGroup


@dataclass(frozen=True)
class StoredShapeState:
    """What a shape's row held when it was loaded, to tell what changed."""

    shape_id: str
    group_id: str
    is_fingerprint: bool
    distance: float
    looks_right: bool
    revision_id: str | None


@dataclass
class StoredGroups:
    """The set's groups as loaded, and the rows they came from."""

    groups: list[ShapeGroup]
    group_ids: dict[int, str]
    shapes: dict[tuple[str, int], StoredShapeState]

    def group_id_of(self, group: ShapeGroup) -> str | None:
        return self.group_ids.get(id(group))


def find_fingerprint_library(mushaf: Mushaf) -> FingerprintLibrary | None:
    return FingerprintLibrary.objects.filter(mushaf=mushaf).first()


def lock_fingerprint_library(mushaf: Mushaf, *, comparison_name: str, limit: float) -> FingerprintLibrary:
    """The mushaf's set row, locked until the transaction ends. Every change to the set
    takes this lock first, so two Confirms (or a Confirm and a Rebuild) line up."""
    # By id, not instance: a created row would otherwise sit cached on ``mushaf`` as it
    # was before the caller changed it.
    FingerprintLibrary.objects.get_or_create(
        mushaf_id=mushaf.pk, defaults={"comparison": comparison_name, "limit": limit}
    )
    return FingerprintLibrary.objects.select_for_update().get(mushaf_id=mushaf.pk)


def encode_features(features: np.ndarray) -> bytes:
    return np.asarray(features, dtype=np.float64).tobytes()


def decode_features(data: bytes | memoryview) -> np.ndarray:
    return np.frombuffer(bytes(data), dtype=np.float64)


def load_stored_groups(library_row: FingerprintLibrary) -> StoredGroups:
    """Every group of the set with its kept shapes, the fingerprint first and the rest
    nearest first, in the order the groups were made."""
    groups: dict[str, ShapeGroup] = {}
    pending: dict[str, list[tuple[bool, KeptShape]]] = {}
    shapes: dict[tuple[str, int], StoredShapeState] = {}
    kinds: dict[str, tuple[str, str]] = {
        str(pk): (role, subtype)
        for pk, role, subtype in FingerprintGroup.objects.filter(library=library_row)
        .order_by("created_at", "pk")
        .values_list("pk", "role", "subtype")
    }
    rows = FingerprintShape.objects.filter(library=library_row).values_list(
        "pk",
        "group_id",
        "snapshot_id",
        "snapshot__page_number",
        "snapshot__line_number",
        "blob_id",
        "revision_id",
        "is_fingerprint",
        "distance",
        "looks_right",
        "features",
    )
    for (
        pk,
        group_id,
        snapshot_id,
        page,
        line,
        blob_id,
        revision_id,
        is_fingerprint,
        distance,
        looks_right,
        data,
    ) in rows:
        shape = KeptShape(
            snapshot_id=str(snapshot_id),
            blob_id=int(blob_id),
            page_number=int(page),
            line_number=int(line),
            revision_id=str(revision_id) if revision_id else None,
            features=decode_features(data),
            distance=float(distance),
            looks_right=bool(looks_right),
        )
        pending.setdefault(str(group_id), []).append((bool(is_fingerprint), shape))
        shapes[shape.key] = StoredShapeState(
            shape_id=str(pk),
            group_id=str(group_id),
            is_fingerprint=bool(is_fingerprint),
            distance=float(distance),
            looks_right=bool(looks_right),
            revision_id=shape.revision_id,
        )
    group_ids: dict[int, str] = {}
    for kind_group_id, (role, subtype) in kinds.items():
        members = pending.get(kind_group_id, [])
        fingerprints = [shape for is_fingerprint, shape in members if is_fingerprint]
        if not fingerprints:
            continue
        kept = sorted((shape for is_fingerprint, shape in members if not is_fingerprint), key=sort_key)
        group = ShapeGroup(role=role, subtype=subtype, fingerprint=fingerprints[0], kept=kept)
        groups[kind_group_id] = group
        group_ids[id(group)] = kind_group_id
    return StoredGroups(groups=list(groups.values()), group_ids=group_ids, shapes=shapes)


def sort_key(shape: KeptShape) -> tuple[float, tuple[str, int]]:
    return (shape.distance, shape.key)


def save_stored_groups(library_row: FingerprintLibrary, stored: StoredGroups) -> None:
    """Write back what changed in ``stored.groups`` since they were loaded: groups that
    went or came, shapes that left, joined, moved, or changed their distance,
    fingerprint or looks-right."""
    present: set[tuple[str, int]] = set()
    created: list[FingerprintShape] = []
    for group in stored.groups:
        group_id = stored.group_id_of(group)
        if group_id is None:
            row = FingerprintGroup.objects.create(library=library_row, role=group.role, subtype=group.subtype)
            group_id = str(row.pk)
            stored.group_ids[id(group)] = group_id
        for index, shape in enumerate(group.shapes()):
            present.add(shape.key)
            is_fingerprint = index == 0
            before = stored.shapes.get(shape.key)
            if before is None:
                created.append(new_shape_row(library_row, group_id, shape, is_fingerprint=is_fingerprint))
                continue
            changes = {
                "group_id": group_id,
                "is_fingerprint": is_fingerprint,
                "distance": shape.distance,
                "looks_right": shape.looks_right,
                "revision_id": shape.revision_id,
            }
            if changes != {
                "group_id": before.group_id,
                "is_fingerprint": before.is_fingerprint,
                "distance": before.distance,
                "looks_right": before.looks_right,
                "revision_id": before.revision_id,
            }:
                FingerprintShape.objects.filter(pk=before.shape_id).update(**changes)
    gone = [state.shape_id for key, state in stored.shapes.items() if key not in present]
    FingerprintShape.objects.filter(pk__in=gone).delete()
    FingerprintShape.objects.bulk_create(created)
    # Last, once every shape that moved out of a group has moved: a group's rows cascade.
    alive_ids = [group_id for group in stored.groups if (group_id := stored.group_id_of(group)) is not None]
    FingerprintGroup.objects.filter(library=library_row).exclude(pk__in=alive_ids).delete()


def replace_stored_groups(library_row: FingerprintLibrary, groups: list[ShapeGroup]) -> None:
    """Throw the set's rows away and write ``groups`` in their place (a Rebuild)."""
    FingerprintGroup.objects.filter(library=library_row).delete()
    created: list[FingerprintShape] = []
    for group in groups:
        row = FingerprintGroup.objects.create(library=library_row, role=group.role, subtype=group.subtype)
        created += [
            new_shape_row(library_row, str(row.pk), shape, is_fingerprint=index == 0)
            for index, shape in enumerate(group.shapes())
        ]
    FingerprintShape.objects.bulk_create(created, batch_size=500)


def new_shape_row(
    library_row: FingerprintLibrary, group_id: str, shape: KeptShape, *, is_fingerprint: bool
) -> FingerprintShape:
    return FingerprintShape(
        library=library_row,
        group_id=group_id,
        snapshot_id=shape.snapshot_id,
        blob_id=shape.blob_id,
        revision_id=shape.revision_id,
        is_fingerprint=is_fingerprint,
        distance=shape.distance,
        looks_right=shape.looks_right,
        features=encode_features(shape.features),
    )


def load_removed_labels(mushaf: Mushaf) -> dict[tuple[str, int], tuple[str, str]]:
    """Every removed blob and the label it was removed as. A removal counts while the
    blob is still confirmed as that role and type."""
    return {
        (str(snapshot_id), int(blob_id)): (role, subtype)
        for snapshot_id, blob_id, role, subtype in RemovedShape.objects.filter(mushaf=mushaf).values_list(
            "snapshot_id", "blob_id", "role", "subtype"
        )
    }


def comparison_of(library_row: FingerprintLibrary) -> Comparison:
    """How the set compares shapes: the comparison it was grouped with."""
    return comparison(library_row.comparison)

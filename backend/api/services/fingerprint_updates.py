"""Changes to the stored fingerprint set: a Confirm, and a person's hand in Library mode.

Each takes the set's lock, changes the groups, and bumps the set's version, so every
server process sees the change at its next lookup::

    add_confirmed_page_to_library   a page confirmed (inside the Confirm's transaction)
    remove_shape_from_library       a badly printed example out, remembered as removed
    restore_removed_shape           ... and back in
    set_shape_looks_right           a person found an example right (or not)

A wrong *label* is not fixed here: it is fixed on its page ("open its source"), because
the export reads the page, and the page's re-confirm updates the set.

The set is a second copy of what the confirmed pages say, so it can drift from them.
Every Confirm checks the page's shapes against its labels; a mismatch never blocks the
Confirm, it flags the set ``needs_rebuild``, and Library mode offers a Rebuild.
:func:`check_every_shape_matches_labels` checks the whole set.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from django.db import transaction

from api.models import CalibrationRevision, CalibrationSnapshot, FingerprintLibrary, Mushaf, RemovedShape
from api.services.calibration_errors import refuse_request
from api.services.calibration_examples import (
    collect_library_examples,
    find_confirmed_revisions,
    load_revision_payloads,
)
from api.services.calibration_settings import serialize_calibration_settings
from api.services.fingerprint_pages import (
    bring_page_into_groups,
    read_page_examples,
)
from api.services.fingerprint_rebuild import build_first_fingerprint_set, is_fingerprint_set_outdated
from api.services.fingerprint_rows import (
    StoredGroups,
    comparison_of,
    load_removed_labels,
    load_stored_groups,
    lock_fingerprint_library,
    save_stored_groups,
)
from api.services.habit_counts import add_page_habits_to_set
from core.word_boundary.library_updates import (
    drop_shape_from_group,
    find_group_of_shape,
    place_examples_in_groups,
    shape_from_sample,
)


@dataclass
class LockedSet:
    library_row: FingerprintLibrary
    stored: StoredGroups


def lock_current_set(mushaf: Mushaf) -> LockedSet | None:
    """The set, locked and loaded — or None when there is none yet (or it is outdated),
    in which case the caller builds it from scratch instead of changing it."""
    settings = serialize_calibration_settings(mushaf)
    library_row = lock_fingerprint_library(mushaf, comparison_name=settings["comparison"], limit=settings["limit"])
    if is_fingerprint_set_outdated(library_row):
        return None
    return LockedSet(library_row, load_stored_groups(library_row))


def commit_set_change(locked: LockedSet) -> FingerprintLibrary:
    save_stored_groups(locked.library_row, locked.stored)
    locked.library_row.version += 1
    locked.library_row.save(update_fields=["version", "needs_rebuild", "habits", "updated_at"])
    return locked.library_row


def add_confirmed_page_to_library(
    mushaf: Mushaf, page_number: int, revision: CalibrationRevision, replaced: CalibrationRevision | None = None
) -> None:
    """Bring a page just confirmed into the set (``docs/plans/fingerprint-set.md`` §2):
    its shapes into the groups, its habit counts into the set's — in place of those of
    ``replaced``, the confirmation it supersedes.

    Runs inside the Confirm's transaction, so the page and the set land together or
    not at all. With no set yet, the set is built from every confirmed page instead —
    this one included.
    """
    locked = lock_current_set(mushaf)
    if locked is None:
        build_first_fingerprint_set(mushaf)
        return
    page = read_page_examples(mushaf, page_number, revision)
    method = comparison_of(locked.library_row)
    removed = load_removed_labels(mushaf)
    matches = bring_page_into_groups(locked.stored.groups, page, removed, method, locked.library_row.limit)
    if not matches:
        locked.library_row.needs_rebuild = True
    add_page_habits_to_set(locked.library_row, revision, replaced)
    commit_set_change(locked)


@transaction.atomic
def remove_shape_from_library(mushaf: Mushaf, snapshot_id: str, blob_id: int) -> FingerprintLibrary:
    """Take a badly printed example out of the set, and remember it as removed so a
    Rebuild never brings it back. A fingerprint hands over to its nearest kept shape."""
    locked = require_current_set(mushaf)
    key = (str(snapshot_id), int(blob_id))
    group = find_group_of_shape(locked.stored.groups, key)
    if group is None:
        refuse_request("not_found", 404, page=0)
    snapshot = CalibrationSnapshot.objects.get(mushaf=mushaf, pk=snapshot_id)
    RemovedShape.objects.update_or_create(
        mushaf=mushaf,
        snapshot=snapshot,
        blob_id=blob_id,
        defaults={"role": group.role, "key": group.key},
    )
    drop_shape_from_group(locked.stored.groups, group, key, comparison_of(locked.library_row))
    return commit_set_change(locked)


@transaction.atomic
def restore_removed_shape(mushaf: Mushaf, snapshot_id: str, blob_id: int) -> FingerprintLibrary:
    """Forget a removal, and put the example back where it fits, as a Confirm would."""
    locked = require_current_set(mushaf)
    removal = RemovedShape.objects.filter(
        mushaf=mushaf, snapshot_id=uuid.UUID(str(snapshot_id)), blob_id=blob_id
    ).first()
    if removal is None:
        refuse_request("not_found", 404, page=0)
    removal.delete()
    sample = find_confirmed_example(mushaf, str(snapshot_id), int(blob_id))
    if sample is not None and (sample["role"], sample["key"]) == (removal.role, removal.key):
        shape = shape_from_sample(sample, distance=0.0, looks_right_keys=frozenset())
        place_examples_in_groups(
            locked.stored.groups,
            [(sample["role"], sample["key"], shape)],
            comparison_of(locked.library_row),
            locked.library_row.limit,
        )
    return commit_set_change(locked)


@transaction.atomic
def set_shape_looks_right(mushaf: Mushaf, snapshot_id: str, blob_id: int, *, looks_right: bool) -> FingerprintLibrary:
    """Mark (or unmark) a kept shape as looking right: it is never dropped by the
    spread rule, and a Rebuild keeps a looks-right fingerprint as a fingerprint."""
    locked = require_current_set(mushaf)
    key = (str(snapshot_id), int(blob_id))
    group = find_group_of_shape(locked.stored.groups, key)
    if group is None:
        refuse_request("not_found", 404, page=0)
    for shape in group.shapes():
        if shape.key == key:
            shape.looks_right = looks_right
    return commit_set_change(locked)


def require_current_set(mushaf: Mushaf) -> LockedSet:
    locked = lock_current_set(mushaf)
    if locked is None:
        build_first_fingerprint_set(mushaf)
        locked = lock_current_set(mushaf)
    if locked is None:
        refuse_request("not_found", 404, page=0)
    return locked


def find_confirmed_example(mushaf: Mushaf, snapshot_id: str, blob_id: int) -> dict | None:
    """The blob as an example of the page that confirms it now, if it still is one."""
    snapshot = CalibrationSnapshot.objects.filter(mushaf=mushaf, pk=snapshot_id).first()
    if snapshot is None:
        return None
    revisions = [
        revision for revision in find_confirmed_revisions(mushaf) if revision.review.page_number == snapshot.page_number
    ]
    for sample in collect_library_examples(mushaf, load_revision_payloads(revisions)):
        if (sample["snapshot_id"], sample["blob_id"]) == (snapshot_id, blob_id):
            return sample
    return None


@dataclass
class SetCheck:
    """What :func:`check_every_shape_matches_labels` found wrong."""

    wrong_label: list[tuple[str, int]]
    unconfirmed: list[tuple[str, int]]
    removed_but_kept: list[tuple[str, int]]

    @property
    def passed(self) -> bool:
        return not (self.wrong_label or self.unconfirmed or self.removed_but_kept)


def check_every_shape_matches_labels(mushaf: Mushaf, *, flag: bool = True) -> SetCheck:
    """Every shape the set keeps against what its page is confirmed as now. A failure
    flags the set ``needs_rebuild`` (unless ``flag`` is off)."""
    settings = serialize_calibration_settings(mushaf)
    with transaction.atomic():
        library_row = lock_fingerprint_library(mushaf, comparison_name=settings["comparison"], limit=settings["limit"])
        groups = load_stored_groups(library_row).groups if library_row.version else []
        labels = {
            (sample["snapshot_id"], sample["blob_id"]): (sample["role"], sample["key"])
            for sample in collect_library_examples(mushaf, load_revision_payloads(find_confirmed_revisions(mushaf)))
        }
        removed = load_removed_labels(mushaf)
        found = SetCheck(wrong_label=[], unconfirmed=[], removed_but_kept=[])
        for group in groups:
            for shape in group.shapes():
                label = labels.get(shape.key)
                if label is None:
                    found.unconfirmed.append(shape.key)
                elif label != group.kind:
                    found.wrong_label.append(shape.key)
                elif removed.get(shape.key) == label:
                    found.removed_but_kept.append(shape.key)
        if flag and not found.passed and library_row.version:
            library_row.needs_rebuild = True
            library_row.save(update_fields=["needs_rebuild", "updated_at"])
    return found

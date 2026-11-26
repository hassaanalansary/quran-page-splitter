"""Regrouping the stored fingerprint set from the confirmed pages.

A Confirm only adds to the groups (:mod:`api.services.fingerprint_pages`). Regrouping
everything from scratch, as :func:`library.build_library` always did, happens only:

- the first time a mushaf needs its set (no set yet, e.g. a copy or an import from
  before the set existed), or after ``FEATURE_VERSION``/``LIBRARY_VERSION`` changed:
  :func:`build_first_fingerprint_set`, inside the asking request, under the set's lock
  so two processes never both build it;
- on a LIMIT or comparison change, a failed check, or the user's Rebuild button:
  :func:`rebuild_fingerprint_set`, as a background job. The old set serves until the
  new one commits.

Both leave removed blobs out and keep a person's looks-right marks: a looks-right
fingerprint stays a fingerprint, and a looks-right member stays kept.

A LIMIT may also be previewed (:func:`build_preview_library`): built in memory at that
LIMIT for Library mode to show, and saved nowhere.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable

from django.db import transaction

from api.models import FingerprintLibrary, Mushaf
from api.services.build_once import BuildOnce
from api.services.calibration_errors import refuse_request
from api.services.calibration_examples import (
    LIBRARY_VERSION,
    collect_library_examples,
    find_confirmed_revisions,
    load_revision_payloads,
)
from api.services.calibration_settings import LIMIT_CEILING, serialize_calibration_settings
from api.services.fingerprint_pages import bring_page_into_groups, read_page_examples
from api.services.fingerprint_rows import (
    find_fingerprint_library,
    load_removed_labels,
    load_stored_groups,
    lock_fingerprint_library,
    replace_stored_groups,
)
from api.services.habit_counts import sum_confirmed_habits
from core.word_boundary.examples import FEATURE_VERSION
from core.word_boundary.library import Library, build_library, comparison
from core.word_boundary.library_updates import ShapeGroup, convert_library_to_groups

#: The last previewed library, so a preview's comparisons do not rebuild it for every
#: blob asked about.
PREVIEW_LIBRARIES: OrderedDict[tuple, Library] = OrderedDict()
#: One build at a time per previewed library (:mod:`api.services.build_once`).
PREVIEW_BUILDS = BuildOnce()


def is_fingerprint_set_outdated(library_row: FingerprintLibrary | None) -> bool:
    """No set yet, or one measured or grouped by code that has changed since."""
    return (
        library_row is None
        or library_row.version == 0
        or library_row.feature_version != FEATURE_VERSION
        or library_row.library_version != LIBRARY_VERSION
    )


def build_first_fingerprint_set(mushaf: Mushaf) -> FingerprintLibrary:
    """The set, built now if it is missing or outdated — once: a request that arrives
    while another process builds it waits on the set's lock, then finds it built."""
    settings = serialize_calibration_settings(mushaf)
    with transaction.atomic():
        library_row = lock_fingerprint_library(mushaf, comparison_name=settings["comparison"], limit=settings["limit"])
        if not is_fingerprint_set_outdated(library_row):
            return library_row
        groups = regroup_confirmed_pages(mushaf, library_row, settings)
        store_regrouped_set(library_row, groups, settings)
    return library_row


def rebuild_fingerprint_set(mushaf: Mushaf, *, progress: Callable[[str], None] | None = None) -> FingerprintLibrary:
    """Regroup the set from every confirmed page, at the settings in force now.

    The grouping runs outside the set's lock, so Confirms carry on meanwhile; a page
    confirmed after it began is brought into the new groups at commit, under the lock.
    ``progress`` hears each step ("detecting" while it groups, "saving" while it
    stores), so a long rebuild keeps its job's heartbeat.
    """
    settings = serialize_calibration_settings(mushaf)
    revisions = find_confirmed_revisions(mushaf)
    seen = {str(revision.pk) for revision in revisions}
    if progress is not None:
        progress("detecting")
    groups = regroup_confirmed_pages(mushaf, find_fingerprint_library(mushaf), settings, revisions=revisions)
    if progress is not None:
        progress("saving")
    with transaction.atomic():
        library_row = lock_fingerprint_library(mushaf, comparison_name=settings["comparison"], limit=settings["limit"])
        removed = load_removed_labels(mushaf)
        method = comparison(settings["comparison"])
        for revision in load_revision_payloads(
            [revision for revision in find_confirmed_revisions(mushaf) if str(revision.pk) not in seen]
        ):
            page = read_page_examples(mushaf, revision.review.page_number, revision)
            bring_page_into_groups(groups, page, removed, method, settings["limit"])
        store_regrouped_set(library_row, groups, settings)
    return library_row


def regroup_confirmed_pages(
    mushaf: Mushaf,
    library_row: FingerprintLibrary | None,
    settings: dict,
    *,
    revisions: list | None = None,
) -> list[ShapeGroup]:
    """Every confirmed page's examples grouped from scratch, minus removed blobs, with
    the current set's looks-right fingerprints kept as fingerprints."""
    previous = load_stored_groups(library_row).groups if library_row is not None and library_row.version else []
    looks_right = {shape.key: group.kind for group in previous for shape in group.shapes() if shape.looks_right}
    looks_right_fingerprints = frozenset(group.fingerprint.key for group in previous if group.fingerprint.looks_right)
    removed = load_removed_labels(mushaf)
    revisions = find_confirmed_revisions(mushaf) if revisions is None else revisions
    samples = [
        sample
        for sample in collect_library_examples(mushaf, load_revision_payloads(revisions))
        if removed.get((sample["snapshot_id"], sample["blob_id"])) != (sample["role"], sample["key"])
    ]
    # A looks-right mark counts while its blob is still confirmed as what it was.
    still_looks_right = frozenset(
        key
        for sample in samples
        if looks_right.get(key := (sample["snapshot_id"], sample["blob_id"])) == (sample["role"], sample["key"])
    )
    method = comparison(settings["comparison"])
    library = build_library(
        samples,
        method=method,
        limit=settings["limit"],
        fingerprint_keys=looks_right_fingerprints & still_looks_right,
    )
    return convert_library_to_groups(library, samples, looks_right_keys=still_looks_right)


def store_regrouped_set(library_row: FingerprintLibrary, groups: list[ShapeGroup], settings: dict) -> None:
    replace_stored_groups(library_row, groups)
    library_row.habits = sum_confirmed_habits(find_confirmed_revisions(library_row.mushaf))
    library_row.comparison = settings["comparison"]
    library_row.limit = settings["limit"]
    library_row.feature_version = FEATURE_VERSION
    library_row.library_version = LIBRARY_VERSION
    library_row.needs_rebuild = False
    library_row.version += 1
    library_row.save()


def build_preview_library(mushaf: Mushaf, limit: float) -> Library:
    """The library every confirmed page would make at ``limit``: for Library mode's
    preview, built in memory and saved nowhere."""
    if not 0 < limit <= LIMIT_CEILING:
        refuse_request("invalid_edits", 422)
    revisions = find_confirmed_revisions(mushaf)
    method = comparison(serialize_calibration_settings(mushaf)["comparison"])
    key = (str(mushaf.pk), tuple(str(revision.pk) for revision in revisions), method.name, limit)
    library = PREVIEW_LIBRARIES.get(key)
    if library is not None:
        return library
    with PREVIEW_BUILDS.lock_for(key):
        library = PREVIEW_LIBRARIES.get(key)
        if library is None:
            removed = load_removed_labels(mushaf)
            samples = [
                sample
                for sample in collect_library_examples(mushaf, load_revision_payloads(revisions))
                if removed.get((sample["snapshot_id"], sample["blob_id"])) != (sample["role"], sample["key"])
            ]
            library = build_library(samples, method=method, limit=limit)
            PREVIEW_LIBRARIES.clear()
            PREVIEW_LIBRARIES[key] = library
    return library

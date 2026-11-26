"""The stored fingerprint set, read for lookups: what every Ink request asks.

``compare`` on every selected blob, ``types`` on every typing change, processing a page:
each needs the mushaf's fingerprint set as a :class:`Library`. It used to be rebuilt
from every confirmed blob per request (4.1 s at 27 pages, growing). Now it is stored,
and a request only reads it::

    load_current_library(mushaf)
      one tiny query for the set's version
      this process holds that version?   → use it
      otherwise                          → load the rows (~0.1 to 0.3 s), hold it
      no set yet, or an outdated one     → build it once (fingerprint_rebuild)

Every process keeps the version it last read and reloads when a Confirm, a Rebuild or
a change in Library mode moved it on. No Redis: the version check is the whole protocol.

Processing a page that is already confirmed asks for the set **without that page's
shapes** (``hiding_page``), so its first guesses stay an honest test of the others.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from api.models import FingerprintLibrary, Mushaf
from api.services.build_once import BuildOnce
from api.services.fingerprint_rebuild import build_first_fingerprint_set, is_fingerprint_set_outdated
from api.services.fingerprint_rows import comparison_of, load_stored_groups, pick_groups_for_keys
from core.text.rasm import find_body_shape_of_key
from core.word_boundary.library import Library
from core.word_boundary.library_updates import build_library_from_groups, hide_shapes_of_page

Doc = dict[str, Any]

#: Libraries by (set row, version, hidden page). A version fixes the set exactly, so a
#: held library is never stale; the row is in the key because a restart or an import
#: deletes a set, and its successor counts its versions from 1 again. The set and one
#: page-hidden copy of it fit.
CURRENT_LIBRARIES: OrderedDict[tuple[str, int, int | None], Library] = OrderedDict()
CURRENT_LIBRARIES_MAX = 2
#: One load at a time per library (:mod:`api.services.build_once`).
LIBRARY_LOADS = BuildOnce()


@dataclass
class CurrentSet:
    """The set's row (its version and settings) and the set as a Library."""

    library_row: FingerprintLibrary
    library: Library


def find_current_set(mushaf: Mushaf) -> FingerprintLibrary:
    """The set's row — built first if the mushaf has none, or an outdated one."""
    library_row = FingerprintLibrary.objects.filter(mushaf=mushaf).first()
    if library_row is None or is_fingerprint_set_outdated(library_row):
        library_row = build_first_fingerprint_set(mushaf)
    return library_row


def load_current_set(mushaf: Mushaf, *, hiding_page: int | None = None) -> CurrentSet:
    """The mushaf's fingerprint set — without ``hiding_page``'s shapes when one is given."""
    library_row = find_current_set(mushaf)
    whole = load_library_version(mushaf, library_row, None)
    if hiding_page is None:
        return CurrentSet(library_row, whole)
    return CurrentSet(library_row, load_library_version(mushaf, library_row, hiding_page, whole=whole))


def load_current_library(mushaf: Mushaf, *, hiding_page: int | None = None) -> Library:
    """The mushaf's fingerprint set as a Library, for a lookup."""
    return load_current_set(mushaf, hiding_page=hiding_page).library


def load_library_for_keys(mushaf: Mushaf, keys: set[str]) -> CurrentSet:
    """The set as a Library of only what a page's reading needs: every mark kind, and the
    body keys of its text with their look-alikes (``fingerprint_rows.pick_groups_for_keys``).
    Read from the rows each time — a page's keys are its own — so the whole set is never
    held for a page however large it grows."""
    library_row = find_current_set(mushaf)
    shapes = {shape for key in keys if (shape := find_body_shape_of_key(key))}
    groups = load_stored_groups(library_row, keys=pick_groups_for_keys(keys, shapes)).groups
    return CurrentSet(library_row, build_library_from_groups(groups, comparison_of(library_row), library_row.limit))


def load_library_version(
    mushaf: Mushaf, library_row: FingerprintLibrary, hiding_page: int | None, *, whole: Library | None = None
) -> Library:
    """The set at the row's version, held by this process once loaded."""
    key = (str(library_row.pk), library_row.version, hiding_page)
    library = take_cached_library(key)
    if library is not None:
        return library
    with LIBRARY_LOADS.lock_for(key):
        library = take_cached_library(key)
        if library is not None:
            return library
        if whole is None:
            library = build_library_from_groups(
                load_stored_groups(library_row).groups, comparison_of(library_row), library_row.limit
            )
        else:
            library = hide_shapes_of_page(whole, hiding_page) if hiding_page is not None else whole
        CURRENT_LIBRARIES[key] = library
        while len(CURRENT_LIBRARIES) > CURRENT_LIBRARIES_MAX:
            CURRENT_LIBRARIES.popitem(last=False)
    return library


def take_cached_library(key: tuple[str, int, int | None]) -> Library | None:
    """The library under ``key`` if this process holds it, marked most recently used."""
    library = CURRENT_LIBRARIES.get(key)
    if library is not None:
        CURRENT_LIBRARIES.move_to_end(key)
    return library


def describe_library_for_draft(
    library_row: FingerprintLibrary, library: Library, pages: list[int], *, hid_own_page: bool, mode: str
) -> Doc:
    """What a draft records about the set it was read with — the receipt that took
    ``CalibrationProfile``'s place."""
    return {
        "version": library_row.version,
        "pages": pages,
        "fingerprints": library.fingerprints,
        "examples": library.examples,
        "limit": library.limit,
        "hid_own_page": hid_own_page,
        "mode": mode,
    }


def read_library_record(document: Doc) -> Doc:
    """The draft's record of the set it was read with. A draft from before the stored
    set (an old bundle, an older processed revision) recorded a ``profile`` instead:
    read the same way, with no version."""
    record: Doc | None = document.get("library")
    if record:
        return record
    profile = document.get("profile") or {}
    return {
        "version": None,
        "pages": profile.get("pages", []),
        "fingerprints": profile.get("fingerprints"),
        "examples": profile.get("examples", 0),
        "limit": profile.get("limit"),
        "hid_own_page": False,
        "mode": profile.get("mode", "shadow"),
    }

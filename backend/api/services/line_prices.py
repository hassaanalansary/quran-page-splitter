"""What the library says before a line search: pieces printed as one, and anchors.

The line search reads blobs against their words' piece counts. Two things the library
knows change its prices, never its rules (``core.word_boundary.alignment``):

* **pieces printed as one** — a blob nearest a key of two or more pieces of one word
  (إلا's ``إ+لا``) may be read as that many for free, and as one at the library's
  price, as sure as the library is (``Blob.library_paws``);
* **anchors** — a blob nearest a piece of two letters or more that only one word of the
  span has, near enough to be sure, is pinned to that word: reading it in another costs
  ``ANCHOR_PRICE`` (``Blob.library_word_id``).

Only the span's own words are asked about, and only for blobs nobody decided.
"""

from __future__ import annotations

from typing import Any

from api.models import CalibrationSnapshot
from api.services import calibration_snapshots as snapshots
from core.text import paws
from core.text.contents import ContentsKey
from core.text.rasm import find_body_shape_of_paw
from core.word_boundary.calibration import SURE_CONFIDENCE, SURE_PRICE
from core.word_boundary.library import Library

Doc = dict[str, Any]

#: The longest run of one word's pieces asked about as printed as one.
LONGEST_RUN = 3
#: An anchor's shape must be this much nearer than the library's LIMIT.
ANCHOR_SHARE = 0.5


def list_span_keys(stream: list[Doc]) -> tuple[list[ContentsKey], dict[str, int]]:
    """Every key the span's words allow — each piece, and each run of up to
    ``LONGEST_RUN`` pieces inside a word — and the word of each piece whose shape no
    other word of the span has (the anchors' words, by shape)."""
    keys: set[ContentsKey] = set()
    owners: dict[str, set[int]] = {}
    for word in stream:
        pieces = tuple(paws(word["text"]))
        for start in range(len(pieces)):
            for end in range(start + 1, min(len(pieces), start + LONGEST_RUN) + 1):
                keys.add(ContentsKey(pieces[start:end], ()))
            owners.setdefault(find_body_shape_of_paw(pieces[start]), set()).add(word["id"])
    unique = {shape: next(iter(ids)) for shape, ids in owners.items() if len(ids) == 1}
    return sorted(keys, key=lambda key: key.bodies or ()), unique


def price_blobs_by_library_keys(
    readings: list[tuple[Doc, Any]],
    stored: dict[str, CalibrationSnapshot],
    stream: list[Doc],
    library: Library,
    unit_of: dict[int, int],
) -> None:
    """Set ``library_paws`` and ``library_word_id`` on the blobs of ``readings`` (each a
    draft row and its measured ink) — see the module docstring. In place."""
    keys, unique = list_span_keys(stream)
    if not keys or not len(library.refs):
        return
    for row, ink in readings:
        snapshot = stored.get(row["snapshot_id"])
        if snapshot is None:
            continue
        features = snapshots.blob_features(snapshot)
        free = [
            blob
            for blob in ink.components
            if blob.label in features and blob.locked_role is None and blob.paw_count == 1
        ]
        if not free:
            continue
        for blob, distances in zip(
            free, library.compare_with_keys([features[blob.label] for blob in free], keys), strict=True
        ):
            if not distances:
                continue
            key, nearest = min(distances.items(), key=lambda item: item[1])
            if nearest > library.limit or not key.bodies:
                continue
            bodies = [body for body in key.bodies if body is not None]
            if len(bodies) > 1:
                single = min((d for k, d in distances.items() if k.bodies and len(k.bodies) == 1), default=None)
                confidence = 1.0 if single is None else (single - nearest) / max(single + nearest, 1e-9)
                blob.library_paws = len(bodies)
                blob.library_paws_price = round(SURE_PRICE * min(1.0, confidence / SURE_CONFIDENCE))
            elif len(bodies[0]) >= 2 and nearest <= ANCHOR_SHARE * library.limit and blob.assigned_word_id is None:
                word = unique.get(find_body_shape_of_paw(bodies[0]))
                if word is not None:
                    blob.library_word_id = unit_of.get(word, word)

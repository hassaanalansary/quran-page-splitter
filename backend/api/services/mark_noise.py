"""The marks that may be noise the line's cutting and cleaning left, not ink of the text.

For a person to erase or not; nothing is erased here. Two kinds:

* a **speck** — a few pixels of ink (``SPECK_SHARE``): the tip of a letter of the
  line above, cut with this one, or a stray dot of the scan. Whatever the library
  makes of it, since specks confirmed as dots teach it that specks are dots — the
  first mushaf's pages 9 and 12-14 have six;
* a **stranger left over** — like nothing the library keeps (``NOISE_DISTANCE``)
  *and* left over by its word's reading (``WordCheck.extra``): its word has every
  mark its text names without it. Which mark is the extra one is the reading's
  assignment, never the order on the line.

``edge`` says the blob touches an edge of the line's box: a hint, never required.
"""

from __future__ import annotations

import statistics
from typing import Any

from core.word_boundary.library import Library

Doc = dict[str, Any]

#: A mark looks like nothing the library keeps when every kept shape, letter or mark,
#: is farther from it than this many LIMITs — beyond any group's reach, so the library
#: would have started a group of its own for it. On the first mushaf's pages 15-17,
#: 99.9 % of 2,064 marks were within 0.92 of one.
NOISE_DISTANCE = 1.0
#: A speck is a mark with less ink than this share of its line's median mark. On the
#: first mushaf's pages 1-17 there were twelve, of 1 to 9 px against marks of ~150 —
#: slivers of the line above cut at the top edge, and stray dots of the scan — while the
#: smallest real marks, the dots inside a pause sign's ج, had 18 px or more (0.11).
SPECK_SHARE = 0.08


def find_noise_marks(library: Library, marks: list[tuple[Doc, Doc, Any]], extra: dict[str, set[int]]) -> list[Doc]:
    """The marks of ``marks`` (row, blob, descriptor) that may be noise — see the module
    docstring. ``extra`` is each row's marks no word's text accounts for."""
    typical: dict[str, float] = {}
    for row, _, _ in marks:
        if row["snapshot_id"] not in typical:
            areas = [blob["area"] for blob in row["blobs"] if blob["role"] == "mark" and not blob.get("erased")]
            typical[row["snapshot_id"]] = statistics.median(areas)
    # A library that does not yet know letters and marks both cannot call anything a
    # stranger: only specks are found then.
    strangers = [
        mark for mark in marks if mark[1]["id"] in extra.get(mark[0]["snapshot_id"], set()) and library.can_propose
    ]
    answers = library.roles_of([features for _, _, features in strangers]) if strangers else []
    far = {
        (row["snapshot_id"], blob["id"]): min(answer["nearest_letter"], answer["nearest_mark"]) / library.limit
        for (row, blob, _), answer in zip(strangers, answers, strict=True)
    }
    found = []
    for row, blob, _ in marks:
        key = (row["snapshot_id"], blob["id"])
        speck = blob["area"] < SPECK_SHARE * typical[row["snapshot_id"]]
        distance = far.get(key)
        if not speck and (distance is None or distance <= NOISE_DISTANCE):
            continue
        box = row["bbox"]
        found.append(
            {
                "snapshot_id": key[0],
                "blob_id": key[1],
                "kind": "speck" if speck else "stranger",
                "edge": (
                    blob["x"] <= box["x"]
                    or blob["y"] <= box["y"]
                    or blob["x"] + blob["w"] >= box["x"] + box["w"]
                    or blob["y"] + blob["h"] >= box["y"] + box["h"]
                ),
                "distance": round(distance, 2) if distance is not None else None,
            }
        )
    return found

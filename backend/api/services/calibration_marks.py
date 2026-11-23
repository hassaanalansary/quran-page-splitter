"""What the ink's own arrangements say about a line's marks, before any shape does.

The word reader (:mod:`api.services.page_reader`) types marks by their text and their
shapes. Two arrangements speak first, whatever each blob looks like:

* the embraced pause sign ``∴`` (:func:`embraced`): three loose dots look like any
  other dots, so the matcher cannot tell them from a letter's. Where the text also has
  it, it is sure; where it has not, it is still the ink's best guess — readings differ
  in where they pause;
* the dots printed inside a pause sign — ج's, قلى's (:func:`sign_parts`): the sign's,
  whatever a dot looks like.

And :func:`lane_of` says which side of the writing line a mark sits on.
"""

from __future__ import annotations

import statistics
from itertools import combinations
from typing import Any

from core.text.marks import Lane
from core.word_boundary.mark_check import PAUSE_KINDS

Doc = dict[str, Any]

#: The embraced pause sign's dots, against the dot they are made of: how far apart
#: their middles may be (a letter's dots touch, or nearly), and how alike in size.
EMBRACED_SPACING = (1.3, 3.5)
EMBRACED_SIZES = 2.0
#: Each of its dots against the line's i'jam dots: no longer than this many times their
#: middle size. A sukun, a wasla, a hamza is roundish and filled too, and a little
#: bigger: on the first mushaf's pages 15-17, all 15 dots of the 5 triples offered were
#: one of those or beside one, 19 px across against dots of 11.
EMBRACED_DOT = 1.6
#: Types a dot of the embraced sign may be taken for by its shape alone.
DOT_KINDS = frozenset({"ijamDot", "waqfMuanaqa"})
#: Pause signs that may hold marks inside their box: every one but the embraced, whose
#: dots stand apart.
SIGN_KINDS = PAUSE_KINDS - {"waqfMuanaqa"}


def lane_of(blob: Doc, band: list[int]) -> Lane:
    """Which side of the writing line a mark sits on — or on it, between the band's edges."""
    top, bottom = band
    middle = blob["y"] + blob["h"] / 2
    return "above" if middle < top else "below" if middle > bottom else "line"


def embraced(row: Doc, kinds: dict[int, str] | None = None) -> set[int]:
    """The dots of every embraced pause sign ``∴`` on a line: three loose dots in a
    triangle above the writing line.

    A dot is a small round blob with little empty space in its box, no bigger than the
    line's i'jam dots (``EMBRACED_DOT``) — and, where ``kinds`` says what each mark is
    typed or taken for, taken for a dot (``DOT_KINDS``). Three make the sign when they
    are about one size, a little apart — a letter's dots, printed as one blob in the
    first mushaf, touch or nearly — and not in a row.
    """
    top = row["band"][0]
    kinds = kinds or {}
    dots = [
        blob
        for blob in row["blobs"]
        if blob["role"] == "mark"
        and not blob.get("erased")
        and blob["y"] + blob["h"] / 2 < top
        and 0.6 <= blob["w"] / max(blob["h"], 1) <= 1.6
        and blob["area"] >= 0.5 * blob["w"] * blob["h"]
        and kinds.get(blob["id"], "ijamDot") in DOT_KINDS
    ]
    sizes = [max(blob["w"], blob["h"]) for blob in dots if kinds.get(blob["id"]) == "ijamDot"]
    size = statistics.median(sizes or [max(blob["w"], blob["h"]) for blob in dots] or [0])
    dots = [blob for blob in dots if max(blob["w"], blob["h"]) <= EMBRACED_DOT * size]
    dots.sort(key=lambda blob: blob["x"])
    found: set[int] = set()
    for index, first in enumerate(dots):
        size = (first["w"] + first["h"]) / 2
        near = [other for other in dots[index + 1 :] if other["x"] - first["x"] <= EMBRACED_SPACING[1] * 2 * size]
        for second, third in combinations(near, 2):
            if is_triangle((first, second, third)):
                found |= {first["id"], second["id"], third["id"]}
    return found


def sign_parts(row: Doc, kinds: dict[int, str]) -> dict[int, str]:
    """The marks printed as one pause sign: the sign, and a smaller mark whose middle lies
    in its box — the dot in ج's bowl, the ق's dots inside قلى. Each takes the sign's
    type; where only the dot's is known, the sign takes the dot's. ``kinds`` is the type
    each mark is typed or taken for. Returns blob id → that type, for every part.
    """
    marks = [blob for blob in row["blobs"] if blob["role"] == "mark" and not blob.get("erased")]
    found: dict[int, str] = {}
    for sign in marks:
        for part in marks:
            if part is sign or part["area"] >= sign["area"]:
                continue
            middle_x, middle_y = part["x"] + part["w"] / 2, part["y"] + part["h"] / 2
            if not (sign["x"] <= middle_x <= sign["x"] + sign["w"] and sign["y"] <= middle_y <= sign["y"] + sign["h"]):
                continue
            kind = next((k for k in (kinds.get(sign["id"]), kinds.get(part["id"])) if k in SIGN_KINDS), None)
            if kind is not None:
                found[sign["id"]] = found[part["id"]] = kind
    return found


def is_triangle(dots: tuple[Doc, Doc, Doc]) -> bool:
    areas = [dot["area"] for dot in dots]
    if max(areas) > EMBRACED_SIZES * min(areas):
        return False
    size = sum((dot["w"] + dot["h"]) / 2 for dot in dots) / 3
    points = [(dot["x"] + dot["w"] / 2, dot["y"] + dot["h"] / 2) for dot in dots]
    low, high = EMBRACED_SPACING
    for (ax, ay), (bx, by) in combinations(points, 2):
        apart = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
        if not low * size <= apart <= high * size:
            return False
    (ax, ay), (bx, by), (cx, cy) = points
    spread = abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
    return bool(spread >= 0.3 * size * size)

"""Every word of a calibration page checked against its text's marks.

``core.word_boundary.mark_check`` matches one word; this gathers what it needs from a
calibration document — each word's text and the pause sign after it, where its letters
sit, the marks the reading gave it, on which side of the line each one is, and what the
type matcher makes of each — and reads the answers back as types:

* a mark nobody typed takes the type its text names, when the word fits its text
  (:func:`apply_text_types`) — typed *by the text*, and a person's typing replaces it;
* a mark a person typed that the text names otherwise is a doubt;
* a word whose ink and text do not fit says what is missing and what is left over.

The embraced pause sign ``∴`` is found from the ink first (:func:`embraced`): three loose
dots look like any other dots, so the matcher cannot tell them from a letter's. Where
the text also has it, it is sure; where it has not, it is still the ink's best guess —
readings differ in where they pause.
"""

from __future__ import annotations

from collections import defaultdict
from itertools import combinations
from typing import Any

from core.text import letters_of, paws, text_marks
from core.text.marks import Lane
from core.word_boundary.examples import TypeIndex, predict_types, type_scores
from core.word_boundary.mark_check import FoundMark, WordCheck, check_word
from quran.services.quran_text import pause_signs

Doc = dict[str, Any]

#: The embraced pause sign's dots, against the dot they are made of: how far apart
#: their middles may be (a letter's dots touch, or nearly), and how alike in size.
EMBRACED_SPACING = (1.3, 3.5)
EMBRACED_SIZES = 2.0


def human_typed(blob: Doc) -> bool:
    """A mark a person typed — the only kind the text never retypes."""
    return (
        blob["role"] == "mark"
        and bool(blob.get("subtype"))
        and bool(blob.get("subtype_explicit", True))
        and blob.get("subtype_source") != "text"
    )


def lane_of(blob: Doc, band: list[int]) -> Lane:
    """Which side of the writing line a mark sits on — or on it, between the band's edges."""
    top, bottom = band
    middle = blob["y"] + blob["h"] / 2
    return "above" if middle < top else "below" if middle > bottom else "line"


def letter_positions(text: str, bodies: list[Doc]) -> list[float]:
    """Where each letter of a word's skeleton sits, page x, right to left.

    Spread evenly over its piece's body when the reading gave the word one body per
    piece; over all its bodies at once otherwise. Only ever a rough position — letters
    are not equally wide — which is why the check weighs it lightly.
    """
    own = sorted(bodies, key=lambda blob: -(blob["x"] + blob["w"]))
    if not own:
        return []
    pieces = paws(text)
    if len(own) == len(pieces):
        positions: list[float] = []
        for piece, body in zip(pieces, own, strict=True):
            count = len(piece)
            positions += [body["x"] + body["w"] - (index + 0.5) * body["w"] / count for index in range(count)]
        return positions
    right = max(blob["x"] + blob["w"] for blob in own)
    left = min(blob["x"] for blob in own)
    count = max(len(letters_of(text)), 1)
    return [right - (index + 0.5) * (right - left) / count for index in range(count)]


def embraced(row: Doc) -> set[int]:
    """The dots of every embraced pause sign ``∴`` on a line: three loose dots in a
    triangle above the writing line.

    A dot is a small round blob with little empty space in its box. Three make the
    sign when they are about one size, a little apart — a letter's dots, printed as
    one blob in the first mushaf, touch or nearly — and not in a row.
    """
    top = row["band"][0]
    dots = [
        blob
        for blob in row["blobs"]
        if blob["role"] == "mark"
        and blob["y"] + blob["h"] / 2 < top
        and 0.6 <= blob["w"] / max(blob["h"], 1) <= 1.6
        and blob["area"] >= 0.5 * blob["w"] * blob["h"]
    ]
    dots.sort(key=lambda blob: blob["x"])
    found: set[int] = set()
    for index, first in enumerate(dots):
        size = (first["w"] + first["h"]) / 2
        near = [other for other in dots[index + 1 :] if other["x"] - first["x"] <= EMBRACED_SPACING[1] * 2 * size]
        for second, third in combinations(near, 2):
            if _triangle((first, second, third)):
                found |= {first["id"], second["id"], third["id"]}
    return found


def _triangle(dots: tuple[Doc, Doc, Doc]) -> bool:
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


def check_rows(
    rows: list[Doc],
    stream: list[Doc],
    marks: list[tuple[Doc, Doc, Any]],
    index: TypeIndex,
    *,
    ijam: bool,
) -> dict[str, dict[int, WordCheck]]:
    """Every labelled word of ``rows`` checked against its text: snapshot id → word id →
    what the check found. ``marks`` are the rows' marks with their descriptors, as
    ``calibration._page_marks`` lists them; ``ijam`` false for a mushaf whose dotting the
    text does not describe.

    A text type is *sure* only if the examples are not sure of another. Replayed over the
    first mushaf's confirmed pages 3-10, the examples' sure guesses were right 5,885 times
    in 5,886, the text's alone 5,676 in 5,698: where two marks sit over one letter — a dot
    and its sukun, a ta's dots and its shadda — the text may swap them, and the shapes
    will not. Where the examples have never seen the text's type (a first round zero),
    they have no say.
    """
    references = {word["id"]: word for word in stream}
    pauses = pause_signs()
    features = [descriptor for _, _, descriptor in marks]
    scores = type_scores(features, index) if index.types else [{} for _ in marks]
    guesses = predict_types(features, index) if index.types else [{} for _ in marks]
    known = set(index.types)
    score_of = {(row["snapshot_id"], blob["id"]): found for (row, blob, _), found in zip(marks, scores, strict=True)}
    guess_of = {(row["snapshot_id"], blob["id"]): found for (row, blob, _), found in zip(marks, guesses, strict=True)}
    checks: dict[str, dict[int, WordCheck]] = {}
    for row in rows:
        hints = dict.fromkeys(embraced(row), "waqfMuanaqa")
        owned: dict[int, list[Doc]] = defaultdict(list)
        for blob in row["blobs"]:
            if blob["role"] in ("body", "mark"):
                for allocation in blob.get("allocations") or []:
                    owned[allocation["word_id"]].append(blob)
        per_word: dict[int, WordCheck] = {}
        for word in row["words"]:
            ident = word["word_id"]
            if ident is None or ident not in references:
                continue
            text = references[ident]["text"]
            own = owned.get(ident, [])
            found = [
                FoundMark(
                    id=blob["id"],
                    x=blob["x"] + blob["w"] / 2,
                    lane=lane_of(blob, row["band"]),
                    typed=blob["subtype"] if human_typed(blob) else "",
                    scores=score_of.get((row["snapshot_id"], blob["id"]), {}),
                    hint=hints.get(blob["id"], ""),
                )
                for blob in own
                if blob["role"] == "mark"
            ]
            check = check_word(
                text_marks(text, pause=pauses.get(ident, ""), ijam=ijam),
                letter_positions(text, [blob for blob in own if blob["role"] == "body"]),
                max(1, word["start_x"] - word["end_x"]),
                found,
            )
            for mark in list(check.sure):
                guess = guess_of.get((row["snapshot_id"], mark), {})
                kind = check.types[mark]
                if guess.get("sure") and guess.get("subtype") not in ("", kind) and kind in known:
                    check.sure.discard(mark)
            per_word[ident] = check
        checks[row["snapshot_id"]] = per_word
    return checks


def apply_text_types(rows: list[Doc], checks: dict[str, dict[int, WordCheck]]) -> int:
    """Type every mark nobody typed with what its text surely names. In place.

    A type the text set earlier and no longer surely names is taken off again — the
    reading moved, or the ink did. A person's type is never touched, and neither is a
    small letter the text locked (its type came with the lock). Returns how many marks
    the text types.
    """
    typed = 0
    for row in rows:
        per_word = checks.get(row["snapshot_id"], {})
        sure = {ident: check.types[ident] for check in per_word.values() for ident in check.sure}
        for blob in row["blobs"]:
            if blob["role"] != "mark" or human_typed(blob) or blob.get("text_role"):
                continue
            kind = sure.get(blob["id"])
            if kind:
                blob.update(subtype=kind, subtype_source="text", subtype_explicit=False)
                typed += 1
            elif blob.get("subtype_source") == "text":
                blob["subtype"] = ""
                blob.pop("subtype_source", None)
    return typed


def summary(checks: dict[str, dict[int, WordCheck]]) -> list[Doc]:
    """The check of every word, as the editor reads it."""
    return [
        {
            "snapshot_id": snapshot_id,
            "word_id": word_id,
            "ok": check.clean,
            "missing": [mark.kind for mark in check.missing],
            "extra": check.extra,
            "disagree": check.disagree,
        }
        for snapshot_id, per_word in checks.items()
        for word_id, check in per_word.items()
    ]

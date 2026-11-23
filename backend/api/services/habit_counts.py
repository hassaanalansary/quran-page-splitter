"""The hand's habits as a confirmed page shows them, and the mushaf's sum of them.

``core.word_boundary.habits`` counts and answers; this reads a confirmed page's draft for
it. For every word of the page, from what each of its blobs holds (its contents key):

* **joins** — which of its pieces one body holds together (printed touching) and which
  are in bodies of their own (apart). Counted only where the word's bodies hold its
  pieces exactly, every letter known;
* **marks** — each mark its text names: inside the body that holds its letter, in a
  mark blob of the word (alone, or joined with a neighbour mark in one blob), or missing.

A confirmation keeps its page's counts (``CalibrationRevision.habits``); the mushaf's
are their sum, kept on its fingerprint set (``FingerprintLibrary.habits``) and changed
with it: added at a Confirm, swapped at a re-confirm, summed again at a Rebuild.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from api.models import CalibrationRevision, FingerprintLibrary
from api.services.blob_contents import TEXT_ROLES, find_contents_of_blob
from core.text import letters_of, paws, text_marks
from core.text.contents import is_key_complete
from core.word_boundary.habits import (
    HabitCounts,
    MarkPlace,
    WordHabits,
    add_habit_counts,
    count_word_habits,
    make_empty_habit_counts,
)
from core.word_boundary.mark_check import PAUSE_KINDS

Doc = dict[str, Any]


def list_word_blobs(row: Doc) -> dict[int, list[Doc]]:
    """Each word's text blobs on a row, by its id."""
    owned: dict[int, list[Doc]] = {}
    for blob in row["blobs"]:
        if blob["role"] not in TEXT_ROLES or blob.get("erased"):
            continue
        for allocation in blob.get("allocations") or []:
            owned.setdefault(allocation["word_id"], []).append(blob)
    return owned


def read_word_joins(pieces: list[str], bodies: list[Doc], word_id: int) -> tuple[bool, ...] | None:
    """Which joins between the word's pieces one body holds — None when its bodies do not
    hold its pieces exactly."""
    holder: list[int] = []
    for index, blob in enumerate(sorted(bodies, key=lambda blob: -(blob["x"] + blob["w"]))):
        key = find_contents_of_blob(blob)
        if not is_key_complete(key) or not key.bodies:
            return None
        allocation = next(a for a in blob["allocations"] if a["word_id"] == word_id)
        holder += [index] * (allocation["paws"] if len(blob["allocations"]) > 1 else len(key.bodies))
    if len(holder) != len(pieces):
        return None
    return tuple(holder[join] == holder[join + 1] for join in range(len(pieces) - 1))


def read_word_mark_places(
    text: str, letters: str, pieces: list[str], blobs: list[Doc], *, ijam: bool
) -> tuple[tuple[int, str, MarkPlace], ...]:
    """Where each mark the word's text names went: inside the body of its letter, in a
    mark blob of the word, or nowhere."""
    starts = []
    seen = 0
    for piece in pieces:
        starts.append(seen)
        seen += len(piece)
    inside: dict[int, Counter[str]] = {}
    at = 0
    for blob in sorted((b for b in blobs if b["role"] == "body"), key=lambda b: -(b["x"] + b["w"])):
        key = find_contents_of_blob(blob)
        if not key.bodies or None in key.bodies:
            return ()
        count = len(key.bodies)
        first = starts[at] if at < len(starts) else len(letters)
        last = starts[at + count] if at + count < len(starts) else len(letters)
        held = Counter(mark for mark in key.marks or () if mark is not None)
        for letter in range(first, last):
            inside[letter] = held
        at += count
    alone: Counter[str] = Counter()
    joined: Counter[str] = Counter()
    for blob in blobs:
        if blob["role"] != "mark":
            continue
        key = find_contents_of_blob(blob)
        named = [mark for mark in key.marks or () if mark is not None]
        (joined if len(named) > 1 else alone).update(named)
    places: list[tuple[int, str, MarkPlace]] = []
    for mark in text_marks(text, ijam=ijam):
        if mark.kind in PAUSE_KINDS:
            continue
        kinds = {mark.kind, mark.base} if mark.kind == "tanween" else {mark.kind}
        place: MarkPlace = "missing"
        held = inside.get(mark.letter, Counter())
        for pool, name in ((held, "inside"), (alone, "alone"), (joined, "joined")):
            kind = next((kind for kind in kinds if pool[kind] > 0), None)
            if kind is not None:
                pool[kind] -= 1
                place = name  # type: ignore[assignment]
                break
        places.append((mark.letter, mark.kind, place))
    return tuple(places)


def count_habits_of_page(document: Doc, *, ijam: bool) -> HabitCounts:
    """A confirmed page's habit counts, from its draft."""
    counts = make_empty_habit_counts()
    references = {word["id"]: word for word in document.get("stream", [])}
    for row in document.get("lines", []):
        owned = list_word_blobs(row)
        for word in row["words"]:
            ident = word["word_id"]
            if ident is None or ident not in references:
                continue
            text = references[ident]["text"]
            letters, pieces = letters_of(text), paws(text)
            blobs = owned.get(ident, [])
            joins = read_word_joins(pieces, [blob for blob in blobs if blob["role"] == "body"], ident)
            marks = read_word_mark_places(text, letters, pieces, blobs, ijam=ijam)
            count_word_habits(counts, WordHabits(letters, tuple(pieces), joins or (), marks))
    return counts


def sum_confirmed_habits(revisions: list[CalibrationRevision]) -> HabitCounts:
    """The mushaf's habits: its confirmed pages' own counts, added."""
    total = make_empty_habit_counts()
    for revision in revisions:
        if revision.habits:
            add_habit_counts(total, revision.habits)
    return total


def add_page_habits_to_set(
    library_row: FingerprintLibrary, revision: CalibrationRevision, replaced: CalibrationRevision | None
) -> None:
    """A page confirmed: its counts added to the set's, the counts of the confirmation it
    replaces taken off. The caller saves the row."""
    total = library_row.habits or make_empty_habit_counts()
    if replaced is not None and replaced.habits:
        add_habit_counts(total, replaced.habits, sign=-1)
    if revision.habits:
        add_habit_counts(total, revision.habits)
    library_row.habits = total


def load_mushaf_habits(library_row: FingerprintLibrary | None) -> HabitCounts:
    """The set's habit counts — empty ones when it has none yet."""
    if library_row is None or not library_row.habits:
        return make_empty_habit_counts()
    habits: HabitCounts = library_row.habits
    return habits

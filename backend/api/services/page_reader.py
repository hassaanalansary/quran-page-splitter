"""Every word of a draft read by the word reader: what each of its blobs holds.

``core.word_boundary.word_reader`` reads one word; this gathers what it needs from a
calibration draft and writes the answers back::

    for each line of the page:
        each blob's descriptor, from the line's snapshot
        the marks' type scores, the ink's arrangements (∴, a sign's dots)
        for each word:
            its text: pieces, letters, the marks it names
            its bodies, each with the library's distance to every key its word allows
            its marks, typed where a person typed them
            read_word  →  every blob's ``reading``; the word's gap, and its check

The library is the mushaf's fingerprint set with **this page's own decided blobs
besides** (``Library.with_page_examples``): a realign teaches the page what a person
told it, and only that page, until it is confirmed. Saving reads nothing.

A body two words share holds the last pieces of one and the first of the next: it is
read as those pieces, and each word is read without them.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from typing import Any

from api.models import CalibrationSnapshot, Mushaf
from api.services import calibration_snapshots as snapshots
from api.services.blob_contents import (
    TEXT_ROLES,
    find_contents_of_blob,
    find_mark_kind,
    is_mark_named_by_person,
    read_decided_key,
    write_reading,
)
from api.services.calibration_marks import embraced, lane_of, sign_parts
from api.services.fingerprint_store import load_library_for_keys
from api.services.habit_counts import load_mushaf_habits
from api.services.mark_noise import find_noise_marks
from core.text import letters_of, paws, text_marks
from core.text.contents import ContentsKey, format_contents_key, is_key_complete
from core.text.marks import TextMark
from core.word_boundary.habits import HabitCounts
from core.word_boundary.library import Library
from core.word_boundary.mark_check import PAUSE_KINDS, FoundMark
from core.word_boundary.word_reader import BodyPiece, WordReading, WordText, read_word
from quran.services.quran_text import pause_signs

Doc = dict[str, Any]


def read_words_of_document(mushaf: Mushaf, document: Doc, *, follows_text: bool) -> None:
    """Read every word of the document's own lines — see the module docstring. In place.

    ``follows_text`` is false for a mushaf whose marks the loaded text does not describe:
    its words are read for their letters alone.
    """
    rows = [row for row in document["lines"] if not row.get("readonly")]
    stored = {
        str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[r["snapshot_id"] for r in rows])
    }
    features = {
        row["snapshot_id"]: snapshots.blob_features(stored[row["snapshot_id"]])
        for row in rows
        if row["snapshot_id"] in stored
    }
    current = load_library_for_keys(mushaf, list_page_keys(document["stream"], ijam=mushaf.ijam_mode != "ignore"))
    library = current.library.with_page_examples(collect_page_examples(rows, features))
    habits = load_mushaf_habits(current.library_row)
    references = {word["id"]: word for word in document["stream"]}
    pauses = pause_signs() if follows_text else {}
    ijam = mushaf.ijam_mode != "ignore"
    noise_marks: list[tuple[Doc, Doc, Any]] = []
    extra: dict[str, set[int]] = {}
    for row in rows:
        own = features.get(row["snapshot_id"], {})
        extra[row["snapshot_id"]] = read_words_of_row(
            row, own, library, habits, references, pauses, ijam=ijam, follows_text=follows_text
        )
        # A doubt asks the other pages alone: the page's own decisions would answer it.
        mark_doubts_of_person_types(
            [blob for blob in row["blobs"] if blob["role"] == "mark" and not blob.get("erased")], own, current.library
        )
        noise_marks += [
            (row, blob, own[blob["id"]])
            for blob in row["blobs"]
            if blob["role"] == "mark" and not blob.get("erased") and blob["id"] in own
        ]
    document["noise"] = find_noise_marks(library, noise_marks, extra)


def list_page_keys(stream: list[Doc], *, ijam: bool) -> set[str]:
    """Every key the span's words allow a body: each run of a word's pieces, alone or
    holding a mark its text names on those letters — what the page's reading may ask
    the library about, and all it loads of the bodies."""
    keys: set[str] = set()
    for word in stream:
        pieces = paws(word["text"])
        named = text_marks(word["text"], ijam=ijam)
        starts = [sum(len(piece) for piece in pieces[:index]) for index in range(len(pieces))]
        for start in range(len(pieces)):
            for end in range(start + 1, len(pieces) + 1):
                run = tuple(pieces[start:end])
                keys.add(format_contents_key(ContentsKey(run, ())))
                first, last = starts[start], starts[start] + sum(len(piece) for piece in run)
                keys |= {
                    format_contents_key(ContentsKey(run, (mark.kind,))) for mark in named if first <= mark.letter < last
                }
    return keys


def collect_page_examples(rows: list[Doc], features: dict[str, dict[int, Any]]) -> list[Doc]:
    """The page's blobs a person decided whole — letters spelled, marks named — as
    examples the page is read with."""
    samples = []
    for row in rows:
        own = features.get(row["snapshot_id"], {})
        for blob in row["blobs"]:
            if blob["role"] not in TEXT_ROLES or blob.get("erased") or blob["id"] not in own:
                continue
            decided = read_decided_key(blob)
            if not is_key_complete(decided):
                continue
            samples.append(
                {
                    "snapshot_id": row["snapshot_id"],
                    "blob_id": blob["id"],
                    "page_number": row["page_number"],
                    "line_number": row["line_number"],
                    "role": blob["role"],
                    "key": format_contents_key(decided),
                    "features": own[blob["id"]],
                }
            )
    return samples


def read_words_of_row(
    row: Doc,
    features: dict[int, Any],
    library: Library,
    habits: HabitCounts,
    references: dict[int, Doc],
    pauses: dict[int, str],
    *,
    ijam: bool,
    follows_text: bool,
) -> set[int]:
    """Read every word of one line. Returns the marks no word's text accounts for."""
    texts = [blob for blob in row["blobs"] if blob["role"] in TEXT_ROLES and not blob.get("erased")]
    marks = [blob for blob in texts if blob["role"] == "mark"]
    scores = dict(
        zip(
            [blob["id"] for blob in marks if blob["id"] in features],
            library.type_scores([features[blob["id"]] for blob in marks if blob["id"] in features]),
            strict=True,
        )
    )
    kinds = {
        blob["id"]: find_mark_kind(blob) or min(scores[blob["id"]], key=scores[blob["id"]].get)
        for blob in marks
        if find_mark_kind(blob) or scores.get(blob["id"])
    }
    hints = {**dict.fromkeys(embraced(row, kinds), "waqfMuanaqa"), **sign_parts(row, kinds)}
    owned: dict[int, list[Doc]] = defaultdict(list)
    for blob in texts:
        for allocation in blob.get("allocations") or []:
            owned[allocation["word_id"]].append(blob)
    shared_pieces: dict[int, dict[int, list[str]]] = defaultdict(dict)
    extra: set[int] = set()
    for word in row["words"]:
        ident = word["word_id"]
        if ident is None or ident not in references:
            continue
        text = references[ident]["text"]
        pieces = paws(text)
        blobs = owned.get(ident, [])
        shared = [blob for blob in blobs if blob["role"] == "body" and len(blob["allocations"]) > 1]
        alone = [blob for blob in blobs if blob not in shared]
        left, right = count_shared_pieces(shared, ident, pieces, shared_pieces)
        kept = pieces[right : len(pieces) - left if left else None]
        first_letter = sum(len(piece) for piece in pieces[:right])
        last_letter = first_letter + sum(len(piece) for piece in kept)
        named = text_marks(text, pause=pauses.get(ident, ""), ijam=ijam) if follows_text else []
        # What the labeling bar offers for the word's blobs: its pieces, and its marks.
        word["pieces"] = pieces
        word["text_marks"] = [{"letter": mark.letter, "kind": mark.kind} for mark in named]
        word_marks = tuple(
            replace(mark, letter=max(mark.letter - first_letter, 0))
            for mark in named
            if first_letter <= mark.letter < last_letter or mark.kind in PAUSE_KINDS
        )
        reading = read_word(
            WordText(letters_of("".join(kept)), tuple(kept), word_marks),
            [
                describe_body_piece(blob, features, library, tuple(kept), word_marks)
                for blob in alone
                if blob["role"] == "body"
            ],
            [
                FoundMark(
                    id=blob["id"],
                    x=blob["x"] + blob["w"] / 2,
                    lane=lane_of(blob, row["band"]),
                    typed=find_mark_kind(blob) if is_mark_named_by_person(blob) else find_text_lock_kind(blob),
                    scores=scores.get(blob["id"], {}),
                    hint=hints.get(blob["id"], ""),
                )
                for blob in alone
                if blob["role"] == "mark"
            ],
            width=max(1, word["start_x"] - word["end_x"]),
            habits=habits,
        )
        write_word_reading(alone, reading, ident, word)
        extra |= set(reading.check.extra)
    for blob in texts:
        pieces_by_word = shared_pieces.get(blob["id"])
        if pieces_by_word and blob["role"] == "body":
            ordered = [piece for _, run in sorted(pieces_by_word.items()) for piece in run]
            write_reading(blob, ContentsKey(tuple(ordered), ()))
    return extra


def find_text_lock_kind(blob: Doc) -> str:
    """The type the text's lock gave a mark — its word's small waw or ya on the line, which
    the text found by place (``calibration._small_letters``); "" for any other mark."""
    return str(blob.get("text_type") or "") if blob.get("text_role") == "mark" else ""


def mark_doubts_of_person_types(marks: list[Doc], features: dict[int, Any], library: Library) -> None:
    """A mark a person typed that the library is sure is another type it knows: most
    often a slip of the hand, and a slip on a confirmed page teaches every page after it.
    The other type goes on the blob as its ``doubt``; nothing is changed. In place."""
    typed = [blob for blob in marks if is_mark_named_by_person(blob) and blob["id"] in features]
    for blob in marks:
        blob.pop("doubt", None)
    guesses = library.predict_types([features[blob["id"]] for blob in typed]) if typed else []
    for blob, guess in zip(typed, guesses, strict=True):
        kind = find_mark_kind(blob)
        if guess["sure"] and guess["kind"] and guess["kind"] != kind and kind in library.types:
            blob["doubt"] = guess["kind"]


def count_shared_pieces(
    shared: list[Doc], word_id: int, pieces: list[str], found: dict[int, dict[int, list[str]]]
) -> tuple[int, int]:
    """How many of a word's pieces the bodies it shares hold: at its end (with the next
    word) and at its start (with the one before). Records each shared body's pieces of
    this word in ``found``."""
    left = right = 0
    for blob in shared:
        ids = [allocation["word_id"] for allocation in blob["allocations"]]
        count = next(allocation["paws"] for allocation in blob["allocations"] if allocation["word_id"] == word_id)
        if word_id == min(ids):
            left += count
            found[blob["id"]][word_id] = pieces[len(pieces) - count :] if count else []
        else:
            right += count
            found[blob["id"]][word_id] = pieces[:count]
    return min(left, len(pieces)), min(right, len(pieces))


def describe_body_piece(
    blob: Doc, features: dict[int, Any], library: Library, pieces: tuple[str, ...], marks: tuple[TextMark, ...]
) -> BodyPiece:
    """A body as the reader sees it: its edges, what a person decided, and the library's
    distance to every key its word allows — each run of its pieces, with each mark its
    letters may hold."""
    keys: list[ContentsKey] = []
    starts = []
    seen = 0
    for piece in pieces:
        starts.append(seen)
        seen += len(piece)
    for start in range(len(pieces)):
        for end in range(start + 1, len(pieces) + 1):
            run = pieces[start:end]
            keys.append(ContentsKey(run, ()))
            first = starts[start]
            last = first + sum(len(piece) for piece in run)
            keys += [ContentsKey(run, (mark.kind,)) for mark in marks if first <= mark.letter < last]
    distances = library.compare_with_keys([features[blob["id"]]], keys)[0] if blob["id"] in features else {}
    return BodyPiece(
        id=blob["id"],
        right=blob["x"] + blob["w"],
        left=blob["x"],
        decided=read_decided_key(blob),
        distances=distances,
    )


def write_word_reading(blobs: list[Doc], reading: WordReading, word_id: int, word: Doc) -> None:
    """A word's reading onto its blobs and its entry. In place."""
    for blob in blobs:
        key = reading.keys.get(blob["id"])
        if key is None:
            continue
        write_reading(blob, key)
        if blob["role"] == "body" and not blob.get("ownership_explicit"):
            count = len(find_contents_of_blob(blob).bodies or ()) or 1
            blob["allocations"] = [{"word_id": word_id, "paws": count}]
    check = reading.check
    word["gap"] = round(reading.gap, 4)
    word["unsure"] = reading.unsure
    word["doubtful"] = sorted(reading.doubtful)
    word["check"] = {
        "missing": [mark.kind for mark in check.missing],
        "extra": check.extra,
        "disagree": check.disagree,
        "tanween": sorted(check.tanween),
    }

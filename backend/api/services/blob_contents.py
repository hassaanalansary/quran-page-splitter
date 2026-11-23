"""What a calibration blob holds: what a person decided, what the engine read.

Every text blob of a draft carries two contents keys (:mod:`core.text.contents`), stored
as their *parts* — ``{"paws": [...], "marks": [...]}``, what the browser reads and
sends — never as strings, so nothing on either side splits one:

    decided    the person's key: may hold open (``?``) and undecided (``*``) parts;
               ``None`` when nobody decided anything
    reading    the engine's: the line search's body or mark first, then the word
               reader's letters and marks

What the blob *is* — the key the export, the library and the next reading go by — is
the decided key with its open parts taken from the reading (:func:`find_contents_of_blob`).
It is written beside the two as ``contents``, so the browser never works it out, and
its ``role`` follows from it; both are written here only (:func:`apply_contents_to_role`):
body when it holds letters, mark when it holds marks only. An ornament or a symbol keeps
its own role until a person calls it text.

``flag`` is what a person says no key can: ``broken`` (one letter in several blobs) or
``uncertain``.
"""

from __future__ import annotations

from typing import Any

from core.text import paws
from core.text.contents import (
    NOTHING_DECIDED,
    ContentsKey,
    ContentsKeyError,
    count_key_paws,
    describe_contents_parts,
    fill_open_parts,
    find_role_of_key,
    is_key_complete,
    read_parts_into_key,
)

Doc = dict[str, Any]

#: The draft format this module reads and writes: 2, blobs that hold contents keys. A
#: draft without it was made before them and is read-only until processed again.
DOCUMENT_FORMAT = 2
#: What a person may flag a blob with.
FLAGS = ("", "broken", "uncertain")
#: Roles of the ink of the text.
TEXT_ROLES = ("body", "mark")
#: A body the line search found, letters not read yet.
SOME_BODY = ContentsKey((None,), None)
#: A mark the line search found, type not read yet.
SOME_MARK = ContentsKey((), (None,))


def is_document_current(document: Doc) -> bool:
    """Whether a draft's blobs hold contents keys — not one made before them."""
    return document.get("format") == DOCUMENT_FORMAT


def read_decided_key(blob: Doc) -> ContentsKey:
    """What a person decided about the blob; nothing when nobody did."""
    return read_stored_key(blob.get("decided"))


def read_reading_key(blob: Doc) -> ContentsKey:
    """What the engine read the blob as; nothing before any reading."""
    return read_stored_key(blob.get("reading"))


def read_stored_key(parts: object) -> ContentsKey:
    try:
        return read_parts_into_key(parts)
    except ContentsKeyError:
        # Stored by this module only, so never expected; a bad key is no decision.
        return NOTHING_DECIDED


def find_contents_of_blob(blob: Doc) -> ContentsKey:
    """What the blob holds: the decided key, its open parts from the reading."""
    return fill_open_parts(read_decided_key(blob), read_reading_key(blob))


def write_decided(blob: Doc, key: ContentsKey) -> None:
    blob["decided"] = None if key == NOTHING_DECIDED else describe_contents_parts(key)
    apply_contents_to_role(blob)


def write_reading(blob: Doc, key: ContentsKey) -> None:
    blob["reading"] = None if key == NOTHING_DECIDED else describe_contents_parts(key)
    apply_contents_to_role(blob)


def apply_contents_to_role(blob: Doc) -> None:
    """The blob's ``contents`` and role, from what it holds. In place.

    A person's decision first; then an ornament or symbol stays one; then the reading;
    a blob read as nothing keeps the role it had.
    """
    contents = find_contents_of_blob(blob)
    blob["contents"] = None if contents == NOTHING_DECIDED else describe_contents_parts(contents)
    decided = find_role_of_key(read_decided_key(blob))
    if decided is not None:
        blob["role"] = decided
        return
    if blob.get("initial_role") in ("ornament", "symbol"):
        blob["role"] = blob["initial_role"]
        return
    read = find_role_of_key(read_reading_key(blob))
    if read is not None:
        blob["role"] = read


def is_role_decided(blob: Doc) -> bool:
    """Whether a person said body or mark — a hard lock for the reading."""
    return find_role_of_key(read_decided_key(blob)) is not None


def find_decided_paws(blob: Doc) -> int | None:
    """How many pieces a person said the blob counts for; None when nobody did."""
    key = read_decided_key(blob)
    if find_role_of_key(key) != "body":
        return None
    return count_key_paws(key)


def find_mark_kind(blob: Doc) -> str:
    """A mark blob's type as one name ("fatha", "hamza+kasra"); "" for anything else, or
    a mark whose type is open."""
    key = find_contents_of_blob(blob)
    if find_role_of_key(key) != "mark" or not key.marks or None in key.marks:
        return ""
    return "+".join(mark for mark in key.marks if mark is not None)


def find_touching_marks(blob: Doc) -> str:
    """The marks a body holds inside its ink, as one name; "" when none or open."""
    key = find_contents_of_blob(blob)
    if find_role_of_key(key) != "body" or not key.marks or None in key.marks:
        return ""
    return "+".join(mark for mark in key.marks if mark is not None)


def is_mark_named_by_person(blob: Doc) -> bool:
    """A mark whose type a person decided — the only kind the reader never renames."""
    key = read_decided_key(blob)
    return find_role_of_key(key) == "mark" and bool(key.marks) and None not in (key.marks or ())


def is_blob_fully_known(blob: Doc) -> bool:
    """Whether what the blob holds is complete: letters spelled, marks named."""
    return is_key_complete(find_contents_of_blob(blob))


def list_owner_paws(blob: Doc, references: dict[int, Doc]) -> list[str]:
    """The pieces of the blob's words, in reading order — what its letters may be."""
    found: list[str] = []
    for allocation in blob.get("allocations") or []:
        word = references.get(allocation["word_id"])
        if word is not None:
            found += paws(word["text"])
    return found


def are_letters_a_run_of(bodies: tuple[str | None, ...], pieces: list[str]) -> bool:
    """Whether a key's bodies are consecutive pieces of ``pieces`` (an open element
    matching any piece) — where a blob's letters must come from."""
    if not bodies or bodies == (None,):
        return True
    for start in range(len(pieces) - len(bodies) + 1):
        window = pieces[start : start + len(bodies)]
        if all(body is None or body == piece for body, piece in zip(bodies, window, strict=True)):
            return True
    return False


def read_decided_edit(new: Doc, blob: Doc, references: dict[int, Doc], allocations: list[Doc]) -> ContentsKey:
    """The decided key a client sent, validated against the blob's words: letters must be
    a run of its owners' pieces, and a shared body's pieces must add up to its key's.
    Raises :class:`ContentsKeyError`."""
    key = read_parts_into_key(new.get("decided"))
    if key.bodies and allocations:
        pieces: list[str] = []
        for allocation in allocations:
            word = references.get(allocation["word_id"])
            if word is not None:
                pieces += paws(word["text"])
        if not are_letters_a_run_of(key.bodies, pieces):
            raise ContentsKeyError("the letters are not pieces of the blob's words")
        count = count_key_paws(key)
        if count is not None and len(allocations) > 1 and sum(a["paws"] for a in allocations) != count:
            raise ContentsKeyError("a shared body's pieces do not add up to its letters")
    return key

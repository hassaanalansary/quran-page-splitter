"""Structure that a person says is text: a sajda or rub' sign, or a piece of an ornament.

Measurement takes two kinds of ink out of the line before anything reads it, and a
draft shows them as structure:

* **symbol** — what the sajda or rub' template matched
  (``core.word_boundary.separators.split_symbols``);
* **ornament** — an aya ornament's ring, and the pieces grouped with it: its digits,
  and now and then a mark of the last word that sits under or over the ring.

When one of them is text after all — a letter's head matched as a rub' star, a kasra
the ring swallowed — the reviewer gives it a text role in Ink, and from then on it is
text::

    measured line        structure, out of the line's ink
    reviewer: B or M     the blob is a body or a mark, decided   (its ``decided`` key)
    next reading         put back into the ink, read with the rest
    decision released    structure again at the next reading

Only a person's decision makes structure text: what nobody decided is what the
measurement says it is. An ornament's **ring** never changes: it closes the aya, and
the reading splits the line there.
"""

from __future__ import annotations

from typing import Any

from api.services.blob_contents import TEXT_ROLES, is_role_decided
from core.word_boundary.ink import Blob, LineInk

Doc = dict[str, Any]

STRUCTURE_ROLES = ("ornament", "symbol")


def is_ornament_ring(blob: Doc) -> bool:
    """A draft blob that is an ornament's ring. A draft made before rings were marked
    says nothing, and then every ornament blob counts as one."""
    return blob["initial_role"] == "ornament" and bool(blob.get("ring", True))


def find_roles_allowed_for_blob(blob: Doc) -> tuple[str, ...]:
    """The roles a draft blob may be given: a ring stays the ornament, any other
    structure may become text and back, and text stays text."""
    initial = blob["initial_role"]
    if is_ornament_ring(blob):
        return ("ornament",)
    if initial in STRUCTURE_ROLES:
        return (initial, *TEXT_ROLES)
    return TEXT_ROLES


def is_structure_taken_as_text(blob: Doc) -> bool:
    """Structure a person says is text — the same decisions that make a text blob's
    role a hard lock (``calibration.constrain_blob_to_decisions``)."""
    return (
        blob["initial_role"] in STRUCTURE_ROLES
        and blob["role"] in TEXT_ROLES
        and bool(is_role_decided(blob) or blob.get("ownership_explicit"))
    )


def find_structure_taken_as_text(row: Doc) -> set[int]:
    """The ids of a row's structure blobs that a person says are text."""
    return {blob["id"] for blob in row["blobs"] if is_structure_taken_as_text(blob)}


def put_structure_back_into_text(ink: LineInk, labels: set[int]) -> None:
    """Give a measured line's structure blobs ``labels`` back to its text ink. In place.

    Back where measurement had them before structure was taken out: the components
    run right to left, ties in label order, as ``analyse_line`` sorted them. A sign
    left with no pieces is no sign. An ornament keeps its place in the list, which
    runs beside its span: its ring is never given back, so no ornament is left empty.
    """
    restored: list[Blob] = [blob for _, group in ink.symbols for blob in group if blob.label in labels]
    separators: list[list[Blob]] = []
    for group in ink.separators:
        kept = [blob for blob in group if blob.label not in labels]
        if not kept:  # the ring among them: the ornament stays whole
            kept = group
        separators.append(kept)
        restored += [blob for blob in group if blob not in kept]
    if not restored:
        return
    symbols = [(name, [blob for blob in group if blob.label not in labels]) for name, group in ink.symbols]
    ink.symbols = [(name, group) for name, group in symbols if group]
    ink.symbol_spans = [(min(b.x for b in group), max(b.right for b in group)) for _, group in ink.symbols]
    ink.separators = separators
    ink.components = sorted([*ink.components, *restored], key=lambda blob: (-blob.right, blob.label))
    ink.bodies = [blob for blob in ink.components if blob.preferred == "body"]
    ink.marks = [blob for blob in ink.components if blob.preferred != "body"]

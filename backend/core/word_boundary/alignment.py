"""Forced alignment: hand the measured ink out to the words the text names.

Arabic joining rules say exactly how many disconnected ink blobs ("pieces of
Arabic word", PAWs) a word must make — letters in ``NON_JOINERS`` never connect to
what follows, so a word breaks there and nowhere else. That makes the blob count a
quantity both sides can compute, the text exactly and the image by measurement, so
matching words to ink is alignment rather than recognition.

The ornaments anchor it. A line's blobs are one right-to-left sequence; the
detected ornaments cut that sequence into stretches, and each stretch is parsed on
its own by a small DP over states ``(which word we are on, how many blobs it has
taken)``. Two moves exist — spend the blob on the current word, or leave it out —
and each is priced. Closing a word on the wrong blob count costs ``COUNT_WEIGHT``,
deliberately more than any appearance judgement, so the spelling wins arguments
with the ink. The cheapest path is the reading; equal-cost paths are remembered as
ambiguity rather than enumerated.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from core.word_boundary.calibration import COUNT_SLACK, COUNT_WEIGHT
from core.word_boundary.ink import Blob, LineInk, attach_marks
from core.word_boundary.inputs import WordInput
from core.word_boundary.results import WordBox

StateKey = tuple[int, int, int | None, int | None]


@dataclass(frozen=True)
class ParseEvent:
    """One right-to-left parser event: text ink or an aya ornament."""

    kind: str
    blob: Blob | None = None


@dataclass
class ParseRecord:
    """Best evidence reading for one compact parser state.

    Full histories and role masks live in the value. The key includes the last
    same-line cut and the current word's left extent because future geometry
    rankings depend on them. Only future-equivalent alternatives are merged.

    "Alternatives" means **equal ``rank``**, which is no longer the same as equal
    cost: since ``rank`` carries ``deviations``, two readings that cost the same
    but bend the spelling by different amounts are now *ordered*, and only the
    ones matching on both are recorded as ambiguous. Someone tracing a vanished
    ambiguity should look there first.
    """

    cost: int
    ends: tuple[int, ...]
    groups: tuple[tuple[int, ...], ...]
    current_group: tuple[int, ...]
    body_mask: int
    role_ambiguous_mask: int = 0
    ambiguous_ends: bool = False
    #: Words that closed on more or fewer blobs than their spelling demands.
    #: The honest quality signal for a line: cost alone cannot be read this way,
    #: since a long line accumulates score cost from every component.
    deviations: int = 0
    #: Non-decreasing body-left cuts within a line. This is a tie-break signal,
    #: not a ban on overlapping handwriting or on promoting mark-like bodies.
    inversions: int = 0
    #: Geometry needed by future transitions, local to the current physical line.
    previous_end: int | None = None
    current_left: int | None = None
    #: Total missing/extra PAWs, not the number of affected words.
    paw_errors: int = 0

    @property
    def rank(self) -> tuple[int, ...]:
        """Order readings by evidence cost, then by how much they had to bend.

        Size no longer needs a separate lexicographic tier: height, width, area
        and band position are all folded into each component's body score, so a
        single number already carries them.

        ``inversions`` breaks remaining ties using same-line body extents.
        It neither adds an evidence penalty nor forbids overlapping words.

        ``deviations`` is a tier and not part of the cost because the cost already
        charges each missing/extra PAW ``COUNT_WEIGHT``. What this settles is the *tie* that
        charge leaves behind — one word off-count plus cheap components can total
        exactly what a clean reading with dearer components totals, and of those
        two the clean one is the better answer. Before this, that tie was broken by
        whichever record the DP happened to reach the key with first.

        i'jam is checked for reporting after selection, not used as a rank tier.
        """
        return (self.cost, self.deviations, self.inversions)


@dataclass
class SegmentParse:
    """One ornament-delimited stretch of a line, parsed on its own."""

    status: str
    reason: str | None
    start_word: int | None
    next_word: int | None
    #: Total evidence cost of the reading that won. Not a count of anything: it
    #: is every component's distance from the role the ink suggests, plus
    #: COUNT_WEIGHT for each word read off its spelling's PAW count. It was once
    #: called ``minimum_flips``, from a model where the parser counted role
    #: changes; nothing has flipped in it for a long time.
    alignment_cost: int | None
    end_sequences: int
    deviations: int = 0
    groups: list[list[int]] = field(default_factory=list)
    labels: set[int] = field(default_factory=set)
    body_labels: set[int] = field(default_factory=set)
    role_ambiguous_labels: set[int] = field(default_factory=set)

    @property
    def resolved(self) -> bool:
        return self.status != "unresolved"


@dataclass
class LineParse:
    status: str
    reason: str | None
    next_word: int | None
    #: The dearest of this line's segments — see ``SegmentParse.alignment_cost``.
    alignment_cost: int | None
    end_sequences: int
    deviations: int = 0
    groups: list[list[int]] = field(default_factory=list)
    #: Word index for each entry of ``groups``. Segments either side of an
    #: ornament are not contiguous in the word stream, so the mapping has to be
    #: carried explicitly rather than inferred from a single start offset.
    word_indices: list[int] = field(default_factory=list)
    #: Components belonging to a segment that resolved. Anything outside this
    #: keeps its preferred role and stays visibly uncommitted.
    committed_labels: set[int] = field(default_factory=set)
    body_labels: set[int] = field(default_factory=set)
    role_ambiguous_labels: set[int] = field(default_factory=set)
    segments: list[SegmentParse] = field(default_factory=list)
    released_locks: list[int] = field(default_factory=list)
    constraint_conflicts: set[int] = field(default_factory=set)


def parser_events(ink: LineInk) -> list[ParseEvent]:
    """Return text components and ornament boundaries in reading order."""
    positioned: list[tuple[int, int, int, ParseEvent]] = []
    for order, blob in enumerate(ink.components):
        positioned.append((-blob.right, 1, order, ParseEvent("component", blob)))
    for _left, right in ink.separator_spans:
        positioned.append((-right, 0, -1, ParseEvent("separator")))
    return [event for _, _, _, event in sorted(positioned)]


def _state_key(word: int, done: int, record: ParseRecord) -> StateKey:
    return word, done, record.previous_end, record.current_left


def _merge_record(target: dict[StateKey, ParseRecord], key: tuple, candidate: ParseRecord) -> None:
    """Retain the best-ranked path, preserving genuinely equal-cost ambiguity.

    Now that ``rank`` carries ``deviations``, fewer arrivals here are true ties:
    two readings that cost the same but bend the spelling different amounts are
    ordered rather than merged, and only the ones that match on both are recorded
    as ambiguity. That is the same tie being settled in both places, on purpose.
    """
    key = _state_key(key[0], key[1], candidate)
    existing = target.get(key)
    if existing is None or candidate.rank < existing.rank:
        target[key] = candidate
        return
    if candidate.rank > existing.rank:
        return

    different_ends = existing.ends != candidate.ends or existing.ambiguous_ends or candidate.ambiguous_ends
    different_roles = existing.body_mask ^ candidate.body_mask
    # Equal rank. Keep the reading that spends the *earliest* ink — ``groups`` holds
    # blob idents in span order, so the lexicographically smaller one is the reading
    # that does not push a word onto a later line when it could sit on this one.
    # Without this the survivor is whichever path the dict happened to reach first,
    # which was harmless while each line was parsed alone and is not now that a
    # reading crosses line breaks: the two readings being merged may place the same
    # word on different lines.
    winner, loser = (
        (candidate, existing)
        if (candidate.groups, candidate.current_group) < (existing.groups, existing.current_group)
        else (existing, candidate)
    )
    winner.ambiguous_ends = different_ends
    winner.role_ambiguous_mask |= loser.role_ambiguous_mask | different_roles
    target[key] = winner


def _advance(
    states: dict[StateKey, ParseRecord], blob: Blob, ident: int, words: list[WordInput], *, allow_full: bool = False
) -> dict[StateKey, ParseRecord]:
    """Keep geometry-distinct paths, discarding only primary-score dominance."""
    nxt: dict[StateKey, ParseRecord] = {}
    for key, record in states.items():
        if blob.locked_role != "body" and blob.assigned_word_id is None:
            _merge_record(nxt, key, _with_mark(record, blob))
        for produced_key, produced in _with_body(record, blob, ident, words, key, allow_full=allow_full):
            _merge_record(nxt, produced_key, produced)
    # Geometry affects only the third rank tier. A worse (cost, deviations)
    # prefix at the same word/count can never beat the better prefix's suffix.
    best: dict[tuple[int, int, bool], tuple[int, ...]] = {}
    for key, record in nxt.items():
        prefix = (key[0], key[1], bool(record.current_group))
        best[prefix] = min(best.get(prefix, record.rank[:2]), record.rank[:2])
    return {
        key: record
        for key, record in nxt.items()
        if record.rank[:2] == best[(key[0], key[1], bool(record.current_group))]
    }


def _line_end(states: dict[StateKey, ParseRecord]) -> dict[StateKey, ParseRecord]:
    kept: dict[StateKey, ParseRecord] = {}
    for key, record in states.items():
        if key[1] == 0 and not record.current_group:
            _merge_record(kept, key, replace(record, previous_end=None, current_left=None))
    return kept


def _with_mark(record: ParseRecord, blob: Blob) -> ParseRecord:
    return ParseRecord(
        cost=record.cost + blob.cost_as_mark,
        ends=record.ends,
        groups=record.groups,
        current_group=record.current_group,
        body_mask=record.body_mask,
        role_ambiguous_mask=record.role_ambiguous_mask,
        ambiguous_ends=record.ambiguous_ends,
        deviations=record.deviations,
        inversions=record.inversions,
        previous_end=record.previous_end,
        current_left=record.current_left,
        paw_errors=record.paw_errors,
    )


def _with_body(
    record: ParseRecord,
    blob: Blob,
    ident: int,
    words: list[WordInput],
    state: tuple,
    *,
    allow_full: bool = False,
) -> list[tuple[StateKey, ParseRecord]]:
    """Every way this component can extend or finish the current word.

    A word may close having taken up to COUNT_SLACK blobs more or fewer than its
    spelling demands, priced at COUNT_WEIGHT each. That is what keeps a fused
    word from collapsing the line: the merge is charged once, the word still gets
    a boundary, and the next word starts where it should.
    """
    word_index, done = state[:2]
    if blob.locked_role == "mark" or word_index >= len(words):
        return []
    if blob.assigned_word_id is not None and blob.assigned_word_id != words[word_index].id:
        return []
    want = words[word_index].paws
    done += blob.paw_count
    if done > want + COUNT_SLACK:
        return []

    # ``ident`` rather than ``blob.label``: a label is only unique within its own
    # line, and a reading now runs across line breaks, so groups and the role mask
    # are keyed by the blob's position in the span's flat reading order.
    group = (*record.current_group, ident)
    cost = record.cost + blob.cost_as_body
    body_mask = record.body_mask | (1 << ident)
    left = min(record.current_left, blob.x) if record.current_left is not None else blob.x
    backwards = int(record.previous_end is not None and left >= record.previous_end)
    options: list[tuple[tuple[int, int], ParseRecord]] = []

    if done >= max(1, want - COUNT_SLACK):
        options.append(
            (
                (word_index + 1, 0),
                ParseRecord(
                    cost=cost + COUNT_WEIGHT * abs(done - want),
                    ends=(*record.ends, left),
                    groups=(*record.groups, group),
                    current_group=(),
                    body_mask=body_mask,
                    role_ambiguous_mask=record.role_ambiguous_mask,
                    ambiguous_ends=record.ambiguous_ends,
                    deviations=record.deviations + (1 if done != want else 0),
                    inversions=record.inversions + backwards,
                    previous_end=left,
                    paw_errors=record.paw_errors + abs(done - want),
                ),
            )
        )
    if done < want + COUNT_SLACK or allow_full or blob.constrained:
        options.append(
            (
                (word_index, done),
                ParseRecord(
                    cost=cost,
                    ends=record.ends,
                    groups=record.groups,
                    current_group=group,
                    body_mask=body_mask,
                    role_ambiguous_mask=record.role_ambiguous_mask,
                    ambiguous_ends=record.ambiguous_ends,
                    deviations=record.deviations,
                    inversions=record.inversions,
                    previous_end=record.previous_end,
                    current_left=left,
                    paw_errors=record.paw_errors,
                ),
            )
        )
    return [(_state_key(key[0], key[1], candidate), candidate) for key, candidate in options]


def _required_marks_present(record: ParseRecord, words: list[WordInput], start_word: int, ink: LineInk) -> bool:
    """Whether every word kept the mark components its spelling expects.

    Named for the question it can actually answer. It was ``_ijam_floor_ok``,
    which read as "does Arabic orthography require this dot" — it does not ask
    that, and treating the answer as though it did is what made it unsafe. The
    real question is *given this mushaf's script*, must these marks be visible;
    and the script half of that arrives as ``WordBoundaryInput.ijam``, not from
    here. See :data:`core.word_boundary.inputs.IjamMode`.

    Within a script that does draw them, the reasoning is sound and needs nothing
    tuned: every haraka only ever *adds* to the mark count, so the text gives a
    valid floor and never a ceiling. At least as many mark components must survive
    within a word's span as its letters expect dot groups, on the correct side of
    the writing line; a parse that eats the dot of a ``ب`` leaves that word one
    below-mark short.

    Only dots are considered. Consuming a *fatha* as a body stays undetectable,
    since nothing predicts harakat — this narrows the ambiguity rather than
    removing it.
    """
    consumed = {label for group in record.groups for label in group}
    marks = [blob for blob in ink.components if blob.label not in consumed]
    by_label = {blob.label: blob for blob in ink.components}
    for offset, group in enumerate(record.groups):
        if not group:
            continue
        word = words[start_word + offset]
        above, below = word.ijam_above, word.ijam_below
        if not above and not below:
            continue
        bodies = [by_label[label] for label in group]
        left, right = min(b.x for b in bodies), max(b.right for b in bodies)
        seen_above = seen_below = 0
        for mark in marks:
            if left <= mark.x + mark.w / 2 <= right:
                if mark.y + mark.h / 2 < ink.peak:
                    seen_above += 1
                else:
                    seen_below += 1
        if seen_above < above or seen_below < below:
            return False
    return True


def _aya_end_after(cursor: int, aya_starts: list[int]) -> int:
    """The word index at which the aya holding ``cursor`` finishes."""
    for start in aya_starts:
        if start > cursor:
            return start
    return aya_starts[-1]


def apply_parse_roles(ink: LineInk, parsed: LineParse) -> None:
    """Turn parser evidence into the green/grey/blue overlays.

    Components inside a segment that resolved take the role the parse chose.
    Everything else falls back to its preferred role and is flagged blue only
    where the role is genuinely open: a component smaller than this line's body
    scale is drawn as the mark the evidence says it is, so dots and tashkeel stop
    cluttering every unresolved line with boxes suggesting they might be text.
    """
    for blob in ink.components:
        if blob.locked_role is not None:
            blob.role = blob.locked_role
            blob.role_ambiguous = False
        elif blob.label in parsed.committed_labels:
            blob.role = "body" if blob.label in parsed.body_labels else "mark"
            blob.role_ambiguous = blob.label in parsed.role_ambiguous_labels
        else:
            blob.role = "body" if blob.preferred == "body" else "mark"
            blob.role_ambiguous = blob.preferred != "mark-only" and not blob.small_for_body
    ink.bodies = [blob for blob in ink.components if blob.role == "body"]
    ink.marks = [blob for blob in ink.components if blob.role == "mark"]


def build_line_boxes(
    words: list[WordInput],
    indices: list[int],
    groups: list[list[int]],
    ink: LineInk,
) -> list[WordBox]:
    """Word boxes in **image** coordinates, spanning a word's bodies *and* its marks.

    Each mark goes to the body it sits over (:func:`attach_marks`), and the box —
    ``end_x``, where the cut goes, included — takes in every one of them. A word is
    highlighted with its tashkeel: a fatha leaning past its letter, or a kasra under
    the neighbouring one, is still part of the word it belongs to. (Until 2026-09-27
    the horizontal edges were body-only; the user asked for the marks.)

    This is where the tight crop is undone. ``ink.offset_x``/``offset_y`` are added
    once, here, and everything the engine returns is in the caller's own image
    space from that point on.
    """
    by_label = {blob.label: blob for blob in ink.bodies}
    owned = attach_marks(ink)
    boxes: list[WordBox] = []
    for index, word, labels in zip(indices, words, groups, strict=True):
        bodies = [by_label[label] for label in labels]
        parts = [*bodies, *(mark for label in labels for mark in owned[label])]
        left = min(blob.x for blob in parts) + ink.offset_x
        right = max(blob.right for blob in parts) + ink.offset_x
        top = min(blob.y for blob in parts) + ink.offset_y
        bottom = max(blob.bottom for blob in parts) + ink.offset_y
        boxes.append(
            WordBox(
                index=index,
                text=word.text,
                aya=word.aya,
                word_id=word.id,
                expected_paws=word.paws,
                components=labels,
                x=left,
                y=top,
                w=right - left,
                h=bottom - top,
                end_x=left,
            )
        )
    return boxes

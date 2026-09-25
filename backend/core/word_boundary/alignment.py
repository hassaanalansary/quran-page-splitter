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

import logging
from dataclasses import dataclass, field, replace

from core.word_boundary.calibration import COUNT_SLACK, COUNT_WEIGHT, MAX_LIVE_STATES
from core.word_boundary.ink import Blob, LineInk, attach_marks
from core.word_boundary.inputs import IjamMode, WordInput
from core.word_boundary.results import WordBox

logger = logging.getLogger(__name__)

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
    states: dict[StateKey, ParseRecord], blob: Blob, ident: int, words: list[WordInput]
) -> dict[StateKey, ParseRecord]:
    """Keep geometry-distinct paths, discarding only primary-score dominance."""
    nxt: dict[StateKey, ParseRecord] = {}
    for key, record in states.items():
        _merge_record(nxt, key, _with_mark(record, blob))
        for produced_key, produced in _with_body(record, blob, ident, words, key):
            _merge_record(nxt, produced_key, produced)
    # Geometry affects only the third rank tier. A worse (cost, deviations)
    # prefix at the same word/count can never beat the better prefix's suffix.
    best: dict[tuple[int, int], tuple[int, ...]] = {}
    for key, record in nxt.items():
        prefix = key[:2]
        best[prefix] = min(best.get(prefix, record.rank[:2]), record.rank[:2])
    return {key: record for key, record in nxt.items() if record.rank[:2] == best[key[:2]]}


def _line_end(states: dict[StateKey, ParseRecord]) -> dict[StateKey, ParseRecord]:
    kept: dict[StateKey, ParseRecord] = {}
    for key, record in states.items():
        if key[1] == 0:
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
) -> list[tuple[StateKey, ParseRecord]]:
    """Every way this component can extend or finish the current word.

    A word may close having taken up to COUNT_SLACK blobs more or fewer than its
    spelling demands, priced at COUNT_WEIGHT each. That is what keeps a fused
    word from collapsing the line: the merge is charged once, the word still gets
    a boundary, and the next word starts where it should.
    """
    word_index, done = state[:2]
    if word_index >= len(words):
        return []
    want = words[word_index].paws
    done += 1
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
    if done < want + COUNT_SLACK:
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


def _parse_segment(
    events: list[ParseEvent],
    ink: LineInk,
    words: list[WordInput],
    start_word: int | None,
    require_end: int | None,
    ijam: IjamMode = "report",
) -> SegmentParse:
    """Parse one ornament-delimited stretch of a line.

    ``require_end`` is the word index the stretch must finish on when an ornament
    follows it: an ornament closes an aya, so a reading that stops anywhere else
    has mis-assigned words and is rejected outright.
    """
    labels = {event.blob.label for event in events if event.blob is not None}
    if start_word is None:
        logger.info("      no cursor to start from — segment left unresolved")
        return SegmentParse("unresolved", "upstream-unresolved", None, None, None, 0, labels=labels)

    logger.info(
        "      %d blob(s), cursor at word %d%s; text from here: %s",
        len(events),
        start_word,
        f", must finish on word {require_end}" if require_end is not None else ", open end",
        _text_preview(words, start_word, require_end),
    )

    states: dict[StateKey, ParseRecord] = {(start_word, 0, None, None): ParseRecord(0, (), (), (), 0)}
    peak_states = 1
    for event in events:
        assert event.blob is not None
        blob = event.blob
        states = _advance(states, blob, blob.label, words)
        peak_states = max(peak_states, len(states))
        if len(states) > MAX_LIVE_STATES:
            logger.warning(
                "      search budget spent: %d live states past blob #%d (ceiling %d) — segment abandoned",
                len(states),
                blob.label,
                MAX_LIVE_STATES,
            )
            return SegmentParse("unresolved", "search-budget-exceeded", start_word, None, None, 0, labels=labels)

    finals = [
        (state, record)
        for state, record in states.items()
        if state[1] == 0 and (require_end is None or state[0] == require_end)
    ]
    missed_boundary = False
    if not finals and require_end is not None:
        # The aya did not finish where its ornament says it should. Take the best
        # reading anyway and flag it, rather than discarding the whole stretch.
        missed_boundary = True
        finals = [(state, record) for state, record in states.items() if state[1] == 0]
        logger.info(
            "      no reading finished on word %d as the ornament demands; "
            "taking the best of %d that closed a word instead",
            require_end,
            len(finals),
        )
    if not finals:
        logger.info("      no reading closed a word over %d blob(s) — segment unresolved", len(events))
        return SegmentParse("unresolved", "no-parse", start_word, None, None, 0, labels=labels)

    minimum_rank = min(record.rank for _, record in finals)
    minimum = minimum_rank[0]
    best = [(state, record) for state, record in finals if record.rank == minimum_rank]
    representatives: dict[tuple[int, ...], tuple[tuple[int, int], ParseRecord]] = {}
    ambiguous_ends = any(record.ambiguous_ends for _, record in best)
    for state, record in best:
        representatives.setdefault(record.ends, (state, record))
    end_sequences = len(representatives) + (1 if ambiguous_ends and len(representatives) == 1 else 0)

    # Always commit to a reading. A tie is settled deterministically rather than
    # abandoned: a plausible boundary a human can nudge is worth far more than no
    # boundary at all, and the tie is reported so review can be prioritised.
    state, record = representatives[min(representatives)]

    concerns: list[str] = []
    if missed_boundary:
        concerns.append("aya-boundary-missed")
    if record.deviations:
        concerns.append(f"{record.deviations} word(s) off-count")
    if end_sequences > 1:
        concerns.append(f"{end_sequences} equal-cost readings")
    # ── the expected dots, checked where this mushaf's script warrants it ─────
    #
    # ``IJAM`` describes one dotting convention, not a universal fact — Maghribi
    # puts ف's dot below where that table puts it above, and a mushaf may leave
    # final ي undotted. So whether the question is worth asking at all is declared
    # per mushaf and arrives as ``ijam``. See ``inputs.IjamMode``, which also
    # records why there is no mode that lets this *reject* a reading.
    #
    # Asked of the winner, after ranking, because the check needs a *completed*
    # parse: it counts which components were left over as marks, and at any
    # intermediate state the blobs further left are undecided while words overlap
    # wherever a tail sweeps under a neighbour. There is nothing to choose between
    # by this point anyway — every rival that reached the same key is already gone.
    ijam_short = ijam != "ignore" and not _required_marks_present(record, words, start_word, ink)
    if ijam_short:
        # This reading ate a letter's dot. Two quite different things can be behind
        # that, and only one of them is a reason to change the algorithm:
        #
        #   mask empty   no equal-rank alternative was ever discarded on this path,
        #                so the ink really cannot be read without eating a dot.
        #                Nothing the DP could carry would have helped.
        #   mask set     ``_merge_record`` dropped a reading that disagreed about
        #                which blobs are bodies. That one may well have kept the
        #                dot, and it was gone before anything could prefer it.
        #
        # Counting the second kind over a real mushaf is what would decide whether
        # the DP should keep i'jam-distinct alternatives. Saying which it is in the
        # reason means the next ordinary run answers that, with nothing to add.
        concerns.append("i'jam short, alternatives discarded" if record.role_ambiguous_mask else "i'jam short")

    logger.info(
        "      → %s  cost=%d  words %d..%d (%d)  deviations=%d  readings=%d  peak states=%d%s",
        "exact" if not concerns else "scored",
        minimum,
        start_word,
        state[0],
        len(record.groups),
        record.deviations,
        end_sequences,
        peak_states,
        f"  [{', '.join(concerns)}]" if concerns else "",
    )
    if logger.isEnabledFor(logging.DEBUG):
        for offset, group in enumerate(record.groups):
            word = words[start_word + offset]
            logger.debug(
                "        word %-5d %-14s paws want %d got %d%s  i'jam %d↑/%d↓  blobs %s",
                start_word + offset,
                word.text,
                word.paws,
                len(group),
                " OFF" if len(group) != word.paws else "    ",
                word.ijam_above,
                word.ijam_below,
                list(group),
            )

    max_label = max((blob.label for blob in ink.components), default=0)
    return SegmentParse(
        "exact" if not concerns else "scored",
        ", ".join(concerns) or None,
        start_word,
        state[0],
        minimum,
        end_sequences,
        deviations=record.deviations,
        groups=[list(group) for group in record.groups],
        labels=labels,
        body_labels={label for label in range(1, max_label + 1) if record.body_mask & (1 << label)},
        role_ambiguous_labels={label for label in range(1, max_label + 1) if record.role_ambiguous_mask & (1 << label)},
    )


def _text_preview(words: list[WordInput], start: int, end: int | None, limit: int = 6) -> str:
    """The first few words a segment may spend, for a reader following the trace.

    The log is read to answer "which words did it think were here", and word
    indices alone cannot answer that. Bounded because a long stretch would bury
    the line it belongs to.
    """
    stop = min(end if end is not None else start + limit, start + limit, len(words))
    shown = [word.text for word in words[start:stop]]
    if not shown:
        return "(none left)"
    more = (end if end is not None else len(words)) - stop
    return " ".join(shown) + (f" … (+{more})" if more > 0 else "")


def _aya_end_after(cursor: int, aya_starts: list[int]) -> int:
    """The word index at which the aya holding ``cursor`` finishes."""
    for start in aya_starts:
        if start > cursor:
            return start
    return aya_starts[-1]


def parse_line(
    ink: LineInk,
    words: list[WordInput],
    start_word: int | None,
    *,
    aya_starts: list[int],
    ornaments_before: int = 0,
    ijam: IjamMode = "report",
) -> LineParse:
    """Parse a physical line as independent ornament-delimited segments.

    An ornament is an absolute anchor, not merely something to validate against:
    the word following it opens the next aya whatever happened before it. Parsing
    the stretches either side separately means a fused word ahead of an ornament
    can no longer discard the perfectly determined words behind it — and a line
    whose incoming cursor was lost upstream still resolves everything after its
    first ornament.

    An ornament is read *locally*: it closes whichever aya the cursor is inside,
    rather than the k-th aya of the span. Counting ornaments from the start of
    the span instead makes every anchor depend on every earlier detection, so one
    spurious ring anywhere in a sura shifts all of them — and the old code, which
    demanded a perfect global count before it would anchor at all, simply gave up
    on the whole run. The local reading needs no such bargain: a missed ornament
    costs one boundary and the next one re-syncs.

    ``ornaments_before`` is how many ornaments precede this line in the span. It
    is used only to recover when the cursor has been lost altogether, where
    counting is the one thing left that still says which aya an ornament closes.
    """
    starts = set(aya_starts)
    events = parser_events(ink)
    stretches: list[list[ParseEvent]] = [[]]
    for event in events:
        if event.kind == "separator":
            stretches.append([])
        else:
            stretches[-1].append(event)

    logger.info(
        "    parsing %s: %d stretch(es) split by %d ornament(s), cursor in at %s",
        ink.label,
        len(stretches),
        len(stretches) - 1,
        start_word if start_word is not None else "lost",
    )

    segments: list[SegmentParse] = []
    cursor = start_word
    closed_so_far = ornaments_before
    for index, stretch in enumerate(stretches):
        # Every stretch but the last is closed by an ornament, so it must finish
        # on that aya's boundary.
        closed = index < len(stretches) - 1
        require_end: int | None = None
        if closed:
            if cursor is None:
                # Lost upstream. The ornament count is all that is left to say
                # which boundary this is, so a failed line stops costing every
                # line after it.
                require_end = aya_starts[min(closed_so_far + 1, len(aya_starts) - 1)]
            elif stretch or cursor not in starts:
                # An ornament opening a line closes an aya whose words all sat on
                # the line above, and must not consume an aya of its own.
                require_end = _aya_end_after(cursor, aya_starts)
        logger.info("    stretch %d/%d%s", index + 1, len(stretches), " (closed by an ornament)" if closed else "")
        if not stretch:
            logger.info("      no ink — the ornament opens the line, so it takes no aya of its own")
            segments.append(SegmentParse("empty", None, cursor, cursor, 0, 1))
        else:
            segment = _parse_segment(stretch, ink, words, cursor, require_end, ijam)
            segments.append(segment)
            cursor = segment.next_word
        if closed:
            # The ornament is absolute: whatever the stretch made of its ink, the
            # aya ends here and the next word opens the one after it.
            if require_end is not None:
                if cursor != require_end:
                    logger.info("      ornament overrides the cursor: %s → %s", cursor, require_end)
                cursor = require_end
            closed_so_far += 1

    resolved = [s for s in segments if s.resolved and s.groups]
    unresolved = [s for s in segments if not s.resolved]
    groups: list[list[int]] = []
    word_indices: list[int] = []
    for segment in resolved:
        assert segment.start_word is not None
        for offset in range(len(segment.groups)):
            word_indices.append(segment.start_word + offset)
        groups.extend(segment.groups)

    costs = [s.alignment_cost for s in segments if s.alignment_cost is not None]
    concerns = [s.reason for s in segments if s.reason]
    status: str
    reason: str | None
    if unresolved and not resolved:
        status, reason = "unresolved", concerns[0] if concerns else "no-parse"
    elif unresolved:
        status, reason = "partial", "; ".join(concerns) or None
    elif concerns:
        # Boundaries were drawn, but something about them is worth a human look.
        status, reason = "scored", "; ".join(concerns)
    else:
        status, reason = "exact", None

    log = logger.warning if status == "unresolved" else logger.info
    log(
        "    %s → %s%s: %d word(s) placed, cursor %s → %s",
        ink.label,
        status.upper() if status in ("unresolved", "partial") else status,
        f" ({reason})" if reason else "",
        len(groups),
        start_word if start_word is not None else "lost",
        segments[-1].next_word if segments else None,
    )

    return LineParse(
        status,
        reason,
        # An unresolved final segment can still hand on a cursor when every
        # minimum-cost reading consumed the same number of words.
        segments[-1].next_word if segments else None,
        max(costs, default=None),
        # Count ties only. A determined segment reports one reading and must
        # contribute nothing, so a clean line stays at 0 and a flagged one
        # carries the depth of its tie — which is what the reason line claims.
        sum(s.end_sequences for s in segments if s.end_sequences > 1),
        deviations=sum(s.deviations for s in segments),
        groups=groups,
        word_indices=word_indices,
        committed_labels={label for s in resolved for label in s.labels},
        body_labels={label for s in resolved for label in s.body_labels},
        role_ambiguous_labels={label for s in resolved for label in s.role_ambiguous_labels},
        segments=segments,
    )


def apply_parse_roles(ink: LineInk, parsed: LineParse) -> None:
    """Turn parser evidence into the green/grey/blue overlays.

    Components inside a segment that resolved take the role the parse chose.
    Everything else falls back to its preferred role and is flagged blue only
    where the role is genuinely open: a component smaller than this line's body
    scale is drawn as the mark the evidence says it is, so dots and tashkeel stop
    cluttering every unresolved line with boxes suggesting they might be text.
    """
    for blob in ink.components:
        if blob.label in parsed.committed_labels:
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
    """Word boxes in **image** coordinates, with semantic word ends body-only.

    The box grows to cover a word's marks so the drawn rectangle contains its
    tashkeel, but ``end_x`` — where the cut goes — is taken from the bodies alone,
    since a mark leaning past its letter must not move the boundary.

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
        left = min(blob.x for blob in bodies) + ink.offset_x
        right = max(blob.right for blob in bodies) + ink.offset_x
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

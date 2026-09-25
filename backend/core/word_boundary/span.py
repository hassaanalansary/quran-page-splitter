"""Parse a whole span as one search, collapsing only where the text is certain.

``alignment.parse_line`` optimises one ornament-delimited stretch of one line and
hands the next line a single integer cursor. An aya that crosses a line break is
therefore two independent optimisations, and the second cannot reconsider the
first: when its stretch comes up a blob short its only moves are to starve a word
(``COUNT_WEIGHT`` each) or to press a mark into service as a letter.

Measured on ``مصحف المدينة قديم`` p583:l4, that is exactly what happens. Aya 78:37
runs across lines 3 and 4. Line 3 loses a body and ends one word early, so line 4
opens on ``يَمْلِكُونَ`` instead of ``مِنْهُ``; its stretch then needs five bodies and
holds three, and two blobs sitting 45px *above* the writing band become letters
because promoting them (11+12) undercuts starving two words (40). The reading that
would have fixed it — re-reading line 3's alif as a letter — was never a candidate
that lost on cost. It was not a candidate at all.

Here the live states cross line breaks. A line break only *narrows* them, because
a word may not span one; the choice between them is deferred to the next point the
text says a boundary is certain, which is an aya's ornament. There the states are
filtered to those sitting on an aya start, the cheapest is committed, and the
search restarts. So the unit of search is the aya, and a stretch that comes up
short can now be paid for by re-reading the line above.

The collapse at every ornament is also what bounds the cost: see ``_settle``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from core.word_boundary.alignment import (
    LineParse,
    ParseRecord,
    SegmentParse,
    StateKey,
    _advance,
    _aya_end_after,
    _line_end,
    _required_marks_present,
    parser_events,
)
from core.word_boundary.calibration import MAX_LIVE_STATES
from core.word_boundary.ink import Blob, LineInk
from core.word_boundary.inputs import IjamMode, WordInput

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Event:
    """One step of the span's single right-to-left reading order."""

    #: "blob" — ink to spend or skip; "ornament" — an aya closes; "line-end" — a
    #: word may not continue past here.
    kind: str
    line: int
    blob: Blob | None = None
    #: Position in the span's flat blob order. Used as the DP's group entry and
    #: role-mask bit, because ``Blob.label`` is only unique within its own line.
    ident: int = -1
    #: For an ornament: which aya the caller says it closes, "sura:aya".
    aya: str | None = None


@dataclass
class _Commit:
    """One settled reading: the words between two certain boundaries."""

    start_word: int
    end_word: int
    cost: int
    deviations: int
    end_sequences: int
    missed_boundary: bool
    groups: list[tuple[int, ...]]
    role_ambiguous_mask: int = 0
    lines: set[int] = field(default_factory=set)
    event_start: int = 0
    event_stop: int = 0
    next_word: int = 0
    record: ParseRecord | None = None


def _events(inks: list[LineInk]) -> tuple[list[_Event], dict[int, tuple[int, Blob]]]:
    events: list[_Event] = []
    by_ident: dict[int, tuple[int, Blob]] = {}
    ident = 0
    for line, ink in enumerate(inks):
        seen = 0
        for event in parser_events(ink):
            if event.kind == "separator":
                label = ink.separator_ayat[seen] if seen < len(ink.separator_ayat) else None
                events.append(_Event("ornament", line, aya=label))
                seen += 1
            else:
                assert event.blob is not None
                events.append(_Event("blob", line, event.blob, ident))
                by_ident[ident] = (line, event.blob)
                ident += 1
        events.append(_Event("line-end", line))
    return events, by_ident


def _aya_ends(words: list[WordInput]) -> dict[str, int]:
    """Where each aya of the stream finishes, by its "sura:aya" label."""
    ends: dict[str, int] = {}
    for index, word in enumerate(words):
        ends[word.aya] = index + 1
    return ends


def _required_end(aya: str | None, ends: dict[str, int], entry: int, starts: list[int]) -> int:
    """The word index this ornament's aya finishes on.

    Prefer what the caller declared. The alternative — the next boundary after the
    cursor — is only as good as the cursor, and the cursor is exactly what has gone
    wrong on the lines this anchor exists to recover. A label names the boundary
    outright, so a reading that drifted is put back on the right word rather than on
    the one after wherever it happened to stop.

    Falls back to counting when the caller said nothing, or named an aya outside
    this span: a chunked run legitimately starts mid-sura, and an ornament closing
    an aya before the first requested word tells us nothing about where to resume.
    """
    if aya is not None:
        declared = ends.get(aya)
        if declared is not None:
            return declared
    return _aya_end_after(entry, starts)


def _fresh(word: int) -> dict[StateKey, ParseRecord]:
    return {(word, 0, None, None): ParseRecord(0, (), (), (), 0)}


def _settle(
    states: dict[StateKey, ParseRecord],
    require_end: int | None,
) -> tuple[StateKey, ParseRecord, int, bool] | None:
    """Choose one reading from the live states, or None if none closed a word.

    ``require_end`` is the anchor: an ornament closes an aya, so a reading that
    stops anywhere else has mis-assigned words. It is the *exact* next aya start
    after the committed cursor, not merely "some aya start at or beyond it" — the
    looser test admits the reading that placed **no words at all**, because the
    stream's own first word is an aya start too, and that reading then defers a
    whole line's words onto the next line.

    Falling back to the unanchored finals rather than failing is deliberate and
    matches the old behaviour: a plausible boundary a reviewer can nudge beats no
    boundary, and ``missed_boundary`` says which happened.
    """
    finals = [(state, record) for state, record in states.items() if state[1] == 0]
    missed = False
    if require_end is not None:
        anchored = [(s, r) for s, r in finals if s[0] == require_end]
        if anchored:
            finals = anchored
        elif finals:
            missed = True
    if not finals:
        return None

    best_rank = min(record.rank for _, record in finals)
    best = [(s, r) for s, r in finals if r.rank == best_rank]
    ambiguous_ends = any(record.ambiguous_ends for _, record in best)
    distinct_ends = {record.ends for _, record in best}
    end_sequences = len(distinct_ends) + (1 if ambiguous_ends and len(distinct_ends) == 1 else 0)

    # The tie is settled on ``groups`` — tuples of span-order blob idents — rather
    # than on ``ends``. Two reasons, and the first is a correctness one now that a
    # reading crosses lines: ``ends`` holds x coordinates, which are per-line, so
    # comparing them across a line break orders nothing meaningful. Ident order is
    # span order, so the smallest groups is the reading that spends the *earliest*
    # ink — which is also the tie-break a reader expects, since a word that could
    # sit on this line should not be pushed onto the next.
    state, record = min(best, key=lambda pair: pair[1].groups)
    return state, record, end_sequences, missed


def parse_span(
    inks: list[LineInk],
    words: list[WordInput],
    *,
    aya_starts: list[int],
    ijam: IjamMode = "report",
    trace: list[_Commit] | None = None,
) -> tuple[list[LineParse], int | None]:
    """Parse every line of a span together. Returns one LineParse per line, and
    the word index the reading finished on."""
    events, by_ident = _events(inks)
    starts = set(aya_starts)
    aya_ends = _aya_ends(words)

    commits: list[_Commit] = []
    states = _fresh(0)
    entry = 0
    ink_since_anchor = False
    lines_since_anchor: set[int] = set()
    lost: set[int] = set()
    peak = 1
    event_start = 0

    def commit(require_end: int | None, stop: int, *, absolute: bool = False) -> None:
        nonlocal states, entry, ink_since_anchor, lines_since_anchor, event_start
        if absolute and require_end is not None and require_end < entry:
            # A known boundary disproves placements made past it. Discard the
            # affected commits before rewinding so later words cannot be duplicated.
            conflicting = [c for c in commits if c.end_word > require_end]
            for previous in conflicting:
                lost.update(previous.lines)
            commits[:] = [c for c in commits if c.end_word <= require_end]
            lost.update(lines_since_anchor)
            logger.warning(
                "    known aya boundary rewinds cursor %d -> %d; withdrawing %d commit(s)",
                entry,
                require_end,
                len(conflicting),
            )
            entry = require_end
            states = _fresh(entry)
            ink_since_anchor = False
            lines_since_anchor = set()
            event_start = stop
            return
        settled = _settle(states, require_end)
        if settled is None:
            # Nothing closed a word over this stretch. The lines it covered get no
            # cuts; the next ornament re-anchors, which is what keeps one bad line
            # from costing every line after it.
            lost.update(lines_since_anchor)
            logger.info("    no reading closed a word over line(s) %s", sorted(lines_since_anchor))
        else:
            state, record, end_sequences, missed = settled
            logger.info(
                "    → committed words %d..%d over line(s) %s  cost=%d  deviations=%d  readings=%d%s",
                entry,
                state[0],
                sorted(lines_since_anchor),
                record.cost,
                record.deviations,
                end_sequences,
                "  [aya-boundary-missed]" if missed else "",
            )
            if logger.isEnabledFor(logging.DEBUG):
                for offset, group in enumerate(record.groups):
                    word = words[entry + offset]
                    logger.debug(
                        "        word %-5d %-14s paws want %d got %d%s  i'jam %d↑/%d↓  blobs %s",
                        entry + offset,
                        word.text,
                        word.paws,
                        len(group),
                        " OFF" if len(group) != word.paws else "    ",
                        word.ijam_above,
                        word.ijam_below,
                        [by_ident[i][1].label for i in group],
                    )
            commits.append(
                _Commit(
                    start_word=entry,
                    end_word=state[0],
                    cost=record.cost,
                    deviations=record.deviations,
                    end_sequences=end_sequences,
                    missed_boundary=missed,
                    groups=list(record.groups),
                    role_ambiguous_mask=record.role_ambiguous_mask,
                    lines=set(lines_since_anchor),
                    event_start=event_start,
                    event_stop=stop,
                    next_word=require_end if absolute and require_end is not None else state[0],
                    record=record if trace is not None else None,
                )
            )
            entry = state[0]
        # An *ornament* is absolute: the image says the aya ends here, so the next
        # aya opens where the text says and not where this reading happened to stop —
        # otherwise one short aya shifts every aya after it. ``parse_line`` did this
        # with ``cursor = require_end``; losing it in the move to a cross-line search
        # is what let a local failure stop being local.
        #
        # The span's own end is **not** absolute. It is only what the caller asked
        # for, so it may steer the search (``require_end`` above) but must never be
        # written back as though the ink had confirmed it — that would report every
        # unconsumed span as complete and hide the very failure worth reporting.
        if absolute and require_end is not None and entry != require_end:
            logger.info("      boundary overrides the cursor: %s -> %s", entry, require_end)
            entry = require_end
        states = _fresh(entry)
        ink_since_anchor = False
        lines_since_anchor = set()
        event_start = stop

    for event_index, event in enumerate(events):
        if event.kind == "blob":
            assert event.blob is not None
            blob = event.blob
            states = _advance(states, blob, event.ident, words)
            peak = max(peak, len(states))
            ink_since_anchor = True
            lines_since_anchor.add(event.line)
            if len(states) > MAX_LIVE_STATES:
                # Degrade rather than abandon: settle here, which is exactly the
                # old per-stretch behaviour, and carry on with a clean state set.
                logger.warning(
                    "    search budget spent: %d live states on line %d (ceiling %d) "
                    "— committing early and re-anchoring",
                    len(states),
                    event.line,
                    MAX_LIVE_STATES,
                )
                commit(None, event_index + 1)

        elif event.kind == "line-end":
            # A word may not span a line break, so only states that closed one
            # survive. This narrows the candidates without choosing between them.
            kept = _line_end(states)
            if kept:
                states = kept
            elif ink_since_anchor:
                commit(None, event_index + 1)

        else:  # ornament
            declared = aya_ends.get(event.aya) if event.aya else None
            if ink_since_anchor or entry not in starts or (declared is not None and declared != entry):
                commit(_required_end(event.aya, aya_ends, entry, aya_starts), event_index, absolute=True)
            event_start = event_index + 1
            # An ornament opening a line closes an aya whose words all sat on the
            # line above; it takes no aya of its own.

    if ink_since_anchor:
        commit(len(words), len(events))

    logger.info(
        "── span parsed as one search: %d commit(s), peak %d live states, %d line(s) lost ──",
        len(commits),
        peak,
        len(lost),
    )
    if trace is not None:
        trace.extend(commits)
    return _to_lines(inks, words, by_ident, commits, lost, ijam), entry


def _to_lines(
    inks: list[LineInk],
    words: list[WordInput],
    by_ident: dict[int, tuple[int, Blob]],
    commits: list[_Commit],
    lost: set[int],
    ijam: IjamMode,
) -> list[LineParse]:
    """Split the committed readings back into one LineParse per line.

    Safe because a word never spans a line break, so every group belongs wholly to
    one line, and within a commit the groups of a given line are contiguous in the
    word stream.
    """
    parses = [LineParse("exact", None, None, None, 0, groups=[], word_indices=[]) for _ in inks]
    concerns: list[list[str]] = [[] for _ in inks]
    costs: list[list[int]] = [[] for _ in inks]
    ties: list[int] = [0 for _ in inks]
    devs: list[int] = [0 for _ in inks]

    for commit in commits:
        per_line: dict[int, list[tuple[int, tuple[int, ...]]]] = {}
        for offset, group in enumerate(commit.groups):
            if not group:
                continue
            line = by_ident[group[0]][0]
            per_line.setdefault(line, []).append((commit.start_word + offset, group))

        for line, entries in per_line.items():
            parse = parses[line]
            for word_index, group in entries:
                parse.word_indices.append(word_index)
                parse.groups.append([by_ident[i][1].label for i in group])
                for i in group:
                    parse.body_labels.add(by_ident[i][1].label)
                    parse.committed_labels.add(by_ident[i][1].label)
            costs[line].append(commit.cost)
            ties[line] = max(ties[line], commit.end_sequences)
            devs[line] += commit.deviations

            if commit.missed_boundary:
                concerns[line].append("aya-boundary-missed")
            if commit.deviations:
                concerns[line].append(f"{commit.deviations} word(s) off-count")
            if commit.end_sequences > 1:
                concerns[line].append(f"{commit.end_sequences} equal-cost readings")
            if ijam != "ignore" and not _ijam_ok(entries, words, by_ident, inks[line]):
                concerns[line].append(
                    "i'jam short, alternatives discarded" if commit.role_ambiguous_mask else "i'jam short"
                )

        mask = commit.role_ambiguous_mask
        while mask:
            bit = mask & -mask
            ident = bit.bit_length() - 1
            if ident in by_ident:
                line, blob = by_ident[ident]
                parses[line].role_ambiguous_labels.add(blob.label)
            mask ^= bit

    for line, parse in enumerate(parses):
        if line in lost:
            concerns[line].append("aya-boundary-missed")
        if not parse.groups and inks[line].components:
            # Ink, but no word placed on it. Never ``exact``: a line reported clean
            # with nothing on it is the failure this whole change exists to stop —
            # it means the reading skipped the line and put its words elsewhere.
            reason = "aya-boundary-missed" if line in lost else "no-parse"
            parses[line] = LineParse("unresolved", reason, None, None, 0)
            continue
        seen = sorted(set(concerns[line]))
        parse.status = "exact" if not seen else "scored"
        parse.reason = "; ".join(seen) or None
        parse.alignment_cost = max(costs[line], default=None)
        parse.end_sequences = ties[line]
        parse.deviations = devs[line]
        parse.segments = [
            SegmentParse(parse.status, parse.reason, None, None, parse.alignment_cost, parse.end_sequences)
        ]
    return parses


def _ijam_ok(
    entries: list[tuple[int, tuple[int, ...]]],
    words: list[WordInput],
    by_ident: dict[int, tuple[int, Blob]],
    ink: LineInk,
) -> bool:
    """The dot floor, asked of one line's share of a committed reading."""
    start = entries[0][0]
    record = ParseRecord(
        cost=0,
        ends=(),
        groups=tuple(tuple(by_ident[i][1].label for i in group) for _, group in entries),
        current_group=(),
        body_mask=0,
    )
    return _required_marks_present(record, words, start, ink)

"""``detect_words`` — the one thing this package exists to offer.

Give it line images and the words they should contain; get back where every word
sits. Nothing is supplied about the layout: not how many words a line holds, not
where its text starts or stops. All of that is derived, so the same call works on
any mushaf.

The run, in order: measure each line's ink, pull the ornaments out of it, then
align the whole span in one search. The span is not a bag of independent lines — a
word cannot straddle a line break, so where one line stops is where the next
begins, and a reading is only committed where the text says a boundary is certain:
at an aya's ornament. See `core.word_boundary.span`.

Nothing here draws or prints. The result is dataclasses, and turning them into
pictures, a report or database rows is somebody else's job.
"""

from __future__ import annotations

import logging
import time

from core.word_boundary.alignment import (
    LineParse,
    SegmentParse,
    apply_parse_roles,
    build_line_boxes,
)
from core.word_boundary.ink import LineInk, analyse_line
from core.word_boundary.inputs import BlobConstraint, WordBoundaryInput, WordInput, aya_starts
from core.word_boundary.results import (
    FLAGGED_STATUSES,
    STATUSES,
    InkComponent,
    Ornament,
    WordBoundaryResult,
    WordLine,
    WordSegment,
)
from core.word_boundary.separators import prepare_template, split_separators, split_symbols
from core.word_boundary.span import parse_span

logger = logging.getLogger(__name__)


def detect_words(
    source: WordBoundaryInput,
    *,
    separator_threshold: float = 0.35,
) -> WordBoundaryResult:
    """Find every word of ``source.words`` on ``source.lines``.

    The lines must be in reading order and must be text lines — a sura header or a
    besmella carries no words of the stream and would consume the cursor wrongly.

    Every phase narrates itself to ``core.word_boundary.*`` at INFO, with the
    per-component and per-word evidence at DEBUG. Nothing is printed and nothing is
    written: the caller decides where that goes — a per-run file for the web app
    (``api.services.run_logs``), the console for the CLI, nowhere at all for a test.
    """
    words = source.words
    logger.info("═" * 72)
    logger.info(
        "WORD BOUNDARY RUN — %d line(s), %d word(s)%s",
        len(source.lines),
        len(words),
        f", {words[0].aya} .. {words[-1].aya}" if words else "",
    )
    logger.info(
        "  separator template: %s   match threshold %.2f",
        "supplied" if source.separator_template is not None else "none — shape detector alone",
        separator_threshold,
    )
    if source.symbol_templates:
        logger.info(
            "  symbols: %s — removed from the text ink wherever they match",
            ", ".join(source.symbol_templates),
        )
    logger.info(
        "  i'jam: %s",
        {
            "report": "checked and flagged where a word loses one, never acted on",
            "ignored": "not checked — this mushaf's script is not assumed to draw them",
        }["report" if source.ijam == "report" else "ignored"],
    )
    logger.info("═" * 72)

    template = prepare_template(source.separator_template) if source.separator_template is not None else None
    # Prepared once for the whole run, as the ornament's is: the arrays are never
    # mutated, and trimming each one per line would cost more than the matching.
    symbols = {name: prepare_template(image, name) for name, image in source.symbol_templates.items()}

    # One pass, not two: a line's ink and the ornaments pulled out of it belong
    # together in the trace, and nothing about the second step reads across lines.
    logger.info("── measuring ink ──")
    inks: list[LineInk] = []
    for index, line in enumerate(source.lines, start=1):
        logger.info("  [%d/%d] %s", index, len(source.lines), line.label)
        ink = analyse_line(line)
        # Symbols first. The ornament pass records how many text bodies precede
        # each cut point, and a rosette still in `components` would be counted as
        # one; the shape detector's median body height would be skewed by it too.
        split_symbols(ink, symbols)
        split_separators(ink, template, match_threshold=separator_threshold)
        inks.append(ink)

    return detect_prepared(source, inks)


def detect_prepared(source: WordBoundaryInput, inks: list[LineInk]) -> WordBoundaryResult:
    """Align already measured, symbol/ornament-partitioned ink in reading order.

    No image measurement, cropping, matching or CC relabeling is performed.
    One ink is required per source line. Coordinates remain in the full line's
    tight crop, with its original offsets, even when components were filtered.
    Roles and released calibration locks are updated on the supplied blobs.
    """
    started = time.perf_counter()
    if len(inks) != len(source.lines):
        raise ValueError("detect_prepared requires one LineInk per source line")
    _apply_constraints(source, inks)
    words = source.words
    starts = aya_starts(words)
    logger.info(
        "── aligning — %d ornament(s) over the span, %d aya boundary(ies) in the text ──",
        sum(len(ink.separator_spans) for ink in inks),
        len(starts) - 1,
    )

    # One search over the whole span, collapsed only at an aya's ornament, so a
    # line that comes up a blob short can be paid for by re-reading the line above
    # instead of starving a word or promoting a mark. See `span.parse_span`.
    parses, cursor = parse_span(inks, words, aya_starts=starts, ijam=source.ijam)
    for ink, parsed in zip(inks, parses, strict=True):
        apply_parse_roles(ink, parsed)

    # The stream ran dry before the lines did. Ink with no words left to place is
    # not a clean parse of nothing — it is a line the reading never reached, which
    # is what a run that drifted ahead looks like from the far end.
    if cursor is not None and cursor >= len(words):
        for index, (ink, parsed) in enumerate(zip(inks, parses, strict=True)):
            if parsed.groups or not ink.components:
                continue
            logger.warning(
                "    %s: the stream ran out at word %d, but this line still holds %d component(s) "
                "— the reading never reached it",
                ink.label,
                cursor,
                len(ink.components),
            )
            if parsed.constraint_conflicts or "constraint-" in (parsed.reason or ""):
                continue
            parses[index] = LineParse(
                "unresolved", "words-exhausted", cursor, None, 0, released_locks=parsed.released_locks
            )
            apply_parse_roles(ink, parses[index])

    # A prefix-only parse cannot claim success: withdraw the final line's cuts
    # rather than return a plausible reading of an incomplete span.
    reached_end = cursor is not None and cursor == len(words)
    if not reached_end and cursor is not None and parses:
        last = len(parses) - 1
        logger.warning(
            "    %s: the span stopped at word %d of %d — withdrawing this line's cuts rather than "
            "reporting a plausible reading of an incomplete span",
            inks[last].label,
            cursor,
            len(words),
        )
        if "constraint-" not in (parses[last].reason or ""):
            parses[last] = LineParse(
                "unresolved", "unconsumed-text-span", None, None, 0, released_locks=parses[last].released_locks
            )
            apply_parse_roles(inks[last], parses[last])

    # Recovery can withdraw earlier placements or exhaust the text before a
    # forced body. Report every unplaced hard body even if all word IDs appear.
    for ink, parsed in zip(inks, parses, strict=True):
        placed_labels = {label for group in parsed.groups for label in group}
        missing = {
            blob.label
            for blob in ink.components
            if (blob.locked_role == "body" or blob.assigned_word_id is not None) and blob.label not in placed_labels
        }
        if missing:
            parsed.constraint_conflicts.update(missing)
            parsed.status = "partial" if parsed.groups else "unresolved"
            if "constraint-" not in (parsed.reason or ""):
                parsed.reason = "; ".join(filter(None, [parsed.reason, "constraint-conflict"]))
                parsed.segments.append(
                    SegmentParse("unresolved", "constraint-conflict", None, None, None, 0, labels=missing)
                )

    lines = [
        _line_result(source.lines[i].label, source.lines[i].source, ink, parsed, words)
        for i, (ink, parsed) in enumerate(zip(inks, parses, strict=True))
    ]
    placed = {word.index for line in lines for word in line.words}
    complete = placed == set(range(len(words))) and not any("constraint-" in (line.reason or "") for line in lines)
    _log_summary(lines, words, complete, time.perf_counter() - started)
    return WordBoundaryResult(
        lines=lines,
        words_consumed=len(placed),
        complete=complete,
    )


def _apply_constraints(source: WordBoundaryInput, inks: list[LineInk]) -> None:
    """Carry ``source.constraints`` onto the blobs they name, and validate them all.

    Keyed by ``(LineImage.source, blob label)``: a label is only unique within its
    own line. A key that names no surviving text blob raises rather than being
    dropped — a reviewer's decision silently ignored is the one failure worse than
    a refused run.
    """
    by_key: dict[tuple[str, int], list] = {}
    for line, ink in zip(source.lines, inks, strict=True):
        for blob in ink.components:
            by_key.setdefault((line.source, blob.label), []).append(blob)
    for key, constraint in source.constraints.items():
        matches = by_key.get(key, [])
        if len(matches) != 1:
            raise ValueError(f"Constraint key must identify one text component: {key!r}")
        blob = matches[0]
        blob.locked_role = constraint.locked_role
        blob.lock_source = constraint.lock_source
        blob.paw_count = constraint.paw_count
        blob.assigned_word_id = constraint.assigned_word_id
    ids = [word.id for word in source.words]
    for ink in inks:
        for blob in ink.components:
            # Constraints may also arrive set directly on the blobs (a caller that
            # rebuilt the ink itself); building one validates them the same way.
            BlobConstraint(blob.locked_role, blob.lock_source, blob.paw_count, blob.assigned_word_id)
            if blob.assigned_word_id is not None and ids.count(blob.assigned_word_id) > 1:
                raise ValueError(f"Ownership requires unique WordInput.id: {blob.assigned_word_id}")


def _log_summary(lines: list[WordLine], words: list[WordInput], complete: bool, seconds: float) -> None:
    """The table a reader looks at first, and the only place the run is judged.

    Every number here is counted off the result, not accumulated as the run went:
    the summary and the detail above it cannot drift apart if there is only one
    place either is measured from.
    """
    counts = {status: sum(1 for line in lines if line.status == status) for status in STATUSES}
    placed = sum(len(line.words) for line in lines)

    logger.info("═" * 72)
    logger.info(
        "RUN SUMMARY — %d line(s) in %.2fs (%.0f ms a line)",
        len(lines),
        seconds,
        1000 * seconds / max(1, len(lines)),
    )
    logger.info(
        "  %d exact, %d scored, %d partial, %d unresolved",
        counts["exact"],
        counts["scored"],
        counts["partial"],
        counts["unresolved"],
    )
    logger.info(
        "  %d of %d word(s) placed, %d ornament(s) found, span %s",
        placed,
        len(words),
        sum(len(line.ornaments) for line in lines),
        "accounted for" if complete else "INCOMPLETE",
    )
    deviations = sum(line.deviations for line in lines)
    ties = sum(line.end_sequences for line in lines)
    if deviations or ties:
        logger.info("  %d word(s) off their PAW count, %d tie(s) settled deterministically", deviations, ties)

    flagged = [line for line in lines if line.status in FLAGGED_STATUSES]
    if flagged:
        logger.info("  lines worth a look:")
        for line in flagged:
            logger.info("    %-26s %-11s %s", line.label, line.status, line.reason or "")
    logger.info("═" * 72)


def _line_result(
    label: str,
    source: str,
    ink: LineInk,
    parsed: LineParse,
    words: list[WordInput],
) -> WordLine:
    """Turn one parsed line into data, adding the tight-crop offsets back."""
    dx, dy = ink.offset_x, ink.offset_y
    components = [
        InkComponent(
            id=blob.label,
            x=blob.x + dx,
            y=blob.y + dy,
            w=blob.w,
            h=blob.h,
            # ``apply_parse_roles`` has committed every one of these, so the
            # fallback never fires; it is here so the type stays total.
            role=blob.role or ("body" if blob.preferred == "body" else "mark"),
            ambiguous=blob.role_ambiguous,
            body_score=blob.body_score,
        )
        for blob in ink.components
    ]
    # Ornament pieces left ``ink.components`` when the separators were split off,
    # so they are appended rather than interleaved — which keeps the bodies and
    # marks above in the right-to-left order a renderer expects.
    components += [
        InkComponent(
            id=blob.label,
            x=blob.x + dx,
            y=blob.y + dy,
            w=blob.w,
            h=blob.h,
            role="ornament",
            body_score=blob.body_score,
        )
        for ornament in ink.separators
        for blob in ornament
    ]
    # Same treatment for the non-word symbols, and for the same reason: they left
    # `components` before the parse and would otherwise vanish from the result
    # entirely, so a reader of the report or a debug render would see ink on the
    # page with nothing in the data to account for it. A separate role, because
    # they are not ornaments — they close no aya. See `separators.split_symbols`.
    components += [
        InkComponent(
            id=blob.label,
            x=blob.x + dx,
            y=blob.y + dy,
            w=blob.w,
            h=blob.h,
            role="symbol",
            body_score=blob.body_score,
        )
        for _name, symbol in ink.symbols
        for blob in symbol
    ]
    ornaments = [
        Ornament(
            components=[blob.label for blob in ornament],
            left=min(blob.x for blob in ornament) + dx,
            right=max(blob.right for blob in ornament) + dx,
        )
        for ornament in ink.separators
    ]

    boxes = []
    if parsed.groups:
        boxes = build_line_boxes(
            [words[j] for j in parsed.word_indices],
            parsed.word_indices,
            parsed.groups,
            ink,
        )

    return WordLine(
        label=label,
        source=source,
        status=parsed.status,
        reason=parsed.reason,
        cost=parsed.alignment_cost,
        deviations=parsed.deviations,
        end_sequences=parsed.end_sequences,
        band=(ink.band[0] + dy, ink.band[1] + dy),
        crop_offset=(dx, dy),
        components=components,
        ornaments=ornaments,
        words=boxes,
        segments=[
            WordSegment(
                status=segment.status,
                reason=segment.reason,
                words=len(segment.groups),
                end_sequences=segment.end_sequences,
                deviations=segment.deviations,
            )
            for segment in parsed.segments
        ],
        released_locks=parsed.released_locks,
        constraint_conflicts=sorted(parsed.constraint_conflicts),
    )

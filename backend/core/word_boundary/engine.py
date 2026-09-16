"""``detect_words`` — the one thing this package exists to offer.

Give it line images and the words they should contain; get back where every word
sits. Nothing is supplied about the layout: not how many words a line holds, not
where its text starts or stops. All of that is derived, so the same call works on
any mushaf.

The run, in order: measure each line's ink, pull the ornaments out of it, then walk
the lines carrying one cursor through the word stream. The cursor is what makes a
span more than a bag of independent lines — a word cannot straddle a line break, so
where one line stops is where the next begins.

Nothing here draws or prints. The result is dataclasses, and turning them into
pictures, a report or database rows is somebody else's job.
"""

from __future__ import annotations

import logging
import time

from core.word_boundary.alignment import (
    LineParse,
    apply_parse_roles,
    build_line_boxes,
    parse_line,
)
from core.word_boundary.ink import LineInk, analyse_line
from core.word_boundary.inputs import WordBoundaryInput, WordInput, aya_starts
from core.word_boundary.results import (
    FLAGGED_STATUSES,
    STATUSES,
    InkComponent,
    Ornament,
    WordBoundaryResult,
    WordLine,
    WordSegment,
)
from core.word_boundary.separators import prepare_template, split_separators

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
    started = time.perf_counter()
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
    logger.info(
        "  i'jam: %s",
        {
            "report": "checked and flagged where a word loses one, never acted on",
            "ignored": "not checked — this mushaf's script is not assumed to draw them",
        }["report" if source.ijam == "report" else "ignored"],
    )
    logger.info("═" * 72)

    template = prepare_template(source.separator_template) if source.separator_template is not None else None

    # One pass, not two: a line's ink and the ornaments pulled out of it belong
    # together in the trace, and nothing about the second step reads across lines.
    logger.info("── measuring ink ──")
    inks: list[LineInk] = []
    for index, line in enumerate(source.lines, start=1):
        logger.info("  [%d/%d] %s", index, len(source.lines), line.label)
        ink = analyse_line(line)
        split_separators(ink, template, match_threshold=separator_threshold)
        inks.append(ink)

    starts = aya_starts(words)
    logger.info(
        "── aligning — %d ornament(s) over the span, %d aya boundary(ies) in the text ──",
        sum(len(ink.separator_spans) for ink in inks),
        len(starts) - 1,
    )

    parses: list[LineParse] = []
    cursor: int | None = 0
    seen_ornaments = 0
    for ink in inks:
        if cursor is not None and cursor >= len(words) and ink.components:
            # The stream ran dry before the lines did. Ink with no words left to
            # place is not a clean parse of nothing — it is a line the reading never
            # reached, which is exactly what a run that drifted ahead looks like
            # from the far end. The mirror of the prefix-only guard below, and it
            # has to be a finding for the same reason: reported as ``exact`` these
            # lines would carry green dots and nothing to review.
            logger.warning(
                "    %s: the stream ran out at word %d, but this line still holds %d component(s) "
                "— the reading never reached it",
                ink.label,
                cursor,
                len(ink.components),
            )
            parsed = LineParse("unresolved", "words-exhausted", cursor, None, 0)
        else:
            parsed = parse_line(
                ink,
                words,
                cursor,
                aya_starts=starts,
                ornaments_before=seen_ornaments,
                ijam=source.ijam,
            )
        cursor = parsed.next_word
        seen_ornaments += len(ink.separator_spans)
        apply_parse_roles(ink, parsed)
        parses.append(parsed)

    # A prefix-only parse cannot claim success: withdraw the final line's cuts
    # rather than return a plausible reading of an incomplete span.
    complete = cursor is not None and cursor == len(words)
    if not complete and cursor is not None and parses:
        last = len(parses) - 1
        logger.warning(
            "    %s: the span stopped at word %d of %d — withdrawing this line's cuts rather than "
            "reporting a plausible reading of an incomplete span",
            inks[last].label,
            cursor,
            len(words),
        )
        parses[last] = LineParse("unresolved", "unconsumed-text-span", None, None, 0)
        apply_parse_roles(inks[last], parses[last])

    lines = [
        _line_result(source.lines[i].label, source.lines[i].source, ink, parsed, words)
        for i, (ink, parsed) in enumerate(zip(inks, parses, strict=True))
    ]
    _log_summary(lines, words, complete, time.perf_counter() - started)
    return WordBoundaryResult(
        lines=lines,
        words_consumed=cursor if cursor is not None else 0,
        complete=complete,
    )


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
    )

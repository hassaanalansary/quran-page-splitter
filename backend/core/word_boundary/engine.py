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

from core.word_boundary.alignment import (
    LineParse,
    apply_parse_roles,
    build_line_boxes,
    parse_line,
)
from core.word_boundary.ink import LineInk, analyse_line
from core.word_boundary.inputs import WordBoundaryInput, WordInput, aya_starts
from core.word_boundary.results import (
    InkComponent,
    Ornament,
    WordBoundaryResult,
    WordLine,
    WordSegment,
)
from core.word_boundary.separators import prepare_template, split_separators


def detect_words(
    source: WordBoundaryInput,
    *,
    separator_threshold: float = 0.35,
) -> WordBoundaryResult:
    """Find every word of ``source.words`` on ``source.lines``.

    The lines must be in reading order and must be text lines — a sura header or a
    besmella carries no words of the stream and would consume the cursor wrongly.
    """
    template = prepare_template(source.separator_template) if source.separator_template is not None else None

    inks = [analyse_line(line) for line in source.lines]
    for ink in inks:
        split_separators(ink, template, match_threshold=separator_threshold)

    words = source.words
    starts = aya_starts(words)

    parses: list[LineParse] = []
    cursor: int | None = 0
    seen_ornaments = 0
    for ink in inks:
        parsed = parse_line(ink, words, cursor, aya_starts=starts, ornaments_before=seen_ornaments)
        cursor = parsed.next_word
        seen_ornaments += len(ink.separator_spans)
        apply_parse_roles(ink, parsed)
        parses.append(parsed)

    # A prefix-only parse cannot claim success: withdraw the final line's cuts
    # rather than return a plausible reading of an incomplete span.
    complete = cursor is not None and cursor == len(words)
    if not complete and cursor is not None and parses:
        last = len(parses) - 1
        parses[last] = LineParse("unresolved", "unconsumed-text-span", None, None, 0)
        apply_parse_roles(inks[last], parses[last])

    lines = [
        _line_result(source.lines[i].label, source.lines[i].source, ink, parsed, words)
        for i, (ink, parsed) in enumerate(zip(inks, parses, strict=True))
    ]
    return WordBoundaryResult(
        lines=lines,
        words_consumed=cursor if cursor is not None else 0,
        complete=complete,
    )


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
        cost=parsed.minimum_flips,
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

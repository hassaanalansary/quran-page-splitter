"""Drive the word-boundary engine over a span of ayat, in chunks, and store it.

The three pieces existed and nobody joined them: ``prepare_engine_input`` builds what
the engine eats, ``detect_words`` reads the ink, ``save_word_coordinates`` writes the
cuts. This is the loop between them.

**Why chunks.** Measured, the engine is linear at roughly 40-50ms a line with no cost
of its own for starting: 1.2s for a 15-line page, 20.6s for sura 7's 388 lines. So
chunking buys nothing in speed — a chunk's first and last line are cropped at an aya
boundary and have to be re-rendered from the PDF, which *costs* about 0.3s each. What
it buys is the two things a run of that length needs: progress a poller can see, and a
cancel that lands somewhere. One chunk of latency, the same bargain
``core.pipeline`` makes between pages.

**Why aya spans and not page ranges.** The engine walks one cursor through the word
stream, so a chunk has to be a self-contained span it can start from word zero of.
``(sura, aya)`` is the only address that is, which is why ``prepare_engine_input``
takes one.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import Line, LineTypeChoices, Mushaf, Segment
from api.services import line_images as line_images_service
from api.services import word_coordinates, word_inputs
from core.word_boundary import detect_words
from quran.services import words as words_service

logger = logging.getLogger(__name__)

Span = tuple[tuple[int, int], tuple[int, int]]


@dataclass(frozen=True)
class RunPlan:
    """What a run is about to do, settled before it starts."""

    start: tuple[int, int]
    end: tuple[int, int]
    spans: list[Span]
    total_lines: int
    first_page: int
    last_page: int
    #: Things worth saying that are not reasons to refuse — a missing ornament
    #: template, for instance, which only means the shape detector works alone.
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class RunReport:
    lines_done: int
    words_written: int
    unresolved: list[str] = field(default_factory=list)
    cancelled: bool = False


def preflight(mushaf: Mushaf, start: tuple[int, int], end: tuple[int, int] | None) -> RunPlan:
    """Everything checkable while the caller can still be told.

    A background job's failures arrive long after the response has gone, so a bad
    span or an unset riwaya must be caught here or it becomes a *failed run* instead
    of a rejected request. The same reasoning as ``processing.preflight``.
    """
    try:
        system = word_inputs.counting_system_for(mushaf)
    except LookupError as error:
        raise HttpError(422, i18n.t("words_no_riwaya")) from error

    if end is None:
        end = (start[0], words_service.sura_last_aya(system, start[0]))

    first = _locate(mushaf, start)
    last = _locate(mushaf, end, last=True)
    first_line, last_line = first.line, last.line
    if _key(last_line) < _key(first_line):
        raise HttpError(
            422,
            i18n.t(
                "words_span_backwards",
                from_sura=start[0],
                from_aya=start[1],
                to_sura=end[0],
                to_aya=end[1],
            ),
        )

    lines = _span_lines(mushaf, first_line, last_line)
    warnings: list[str] = []
    if line_images_service.separator_template(mushaf) is None:
        warnings.append(
            "This mushaf has no aya separator template, so ornaments are found by shape alone. "
            "Cutting one from a page will make the anchors more reliable."
        )
    return RunPlan(
        start=start,
        end=end,
        spans=chunks(mushaf, start, end, first_line=first_line, last_line=last_line),
        total_lines=len(lines),
        first_page=first_line.page.page_number,
        last_page=last_line.page.page_number,
        warnings=warnings,
    )


def _locate(mushaf: Mushaf, point: tuple[int, int], *, last: bool = False) -> Segment:
    try:
        return line_images_service.locate(mushaf, point[0], point[1], last=last)
    except LookupError as error:
        # The usual cause is not a typo but an unfinished pipeline: detection writes
        # ``Segment.aya_number`` as null on purpose and the renumber walk fills it, so
        # a mushaf that was processed but never renumbered has nowhere to look.
        raise HttpError(422, i18n.t("words_span_not_found", sura=point[0], aya=point[1])) from error


def _key(line: Line) -> tuple[int, int]:
    return (line.page.page_number, line.line_number)


def _span_lines(mushaf: Mushaf, first_line: Line, last_line: Line) -> list[Line]:
    """Every text line from one to the other, in reading order."""
    candidates = (
        Line.objects.filter(
            page__mushaf=mushaf,
            type=LineTypeChoices.TEXT,
            page__page_number__gte=first_line.page.page_number,
            page__page_number__lte=last_line.page.page_number,
        )
        .select_related("page")
        .order_by("page__page_number", "line_number")
    )
    return [line for line in candidates if _key(first_line) <= _key(line) <= _key(last_line)]


def chunks(
    mushaf: Mushaf,
    start: tuple[int, int],
    end: tuple[int, int],
    *,
    target_lines: int = 60,
    first_line: Line | None = None,
    last_line: Line | None = None,
) -> list[Span]:
    """Cut the span into aya ranges of roughly ``target_lines`` lines each.

    Cuts fall on aya boundaries because that is the only address the engine can start
    from. Two consecutive chunks therefore **share** the line the boundary falls on,
    each writing its own half of it — which is safe because ``LineWord`` carries no
    per-line rank to collide over and ``save_word_coordinates`` clears only its own
    word range.

    Falls back to one chunk when the segmentation cannot be read, which is the honest
    answer: better one long run than a wrong split.
    """
    first_line = first_line or _locate(mushaf, start).line
    last_line = last_line or _locate(mushaf, end, last=True).line

    rows = (
        Segment.objects.filter(
            line__page__mushaf=mushaf,
            line__type=LineTypeChoices.TEXT,
            line__page__page_number__gte=first_line.page.page_number,
            line__page__page_number__lte=last_line.page.page_number,
            aya_number__isnull=False,
            line__sura__isnull=False,
        )
        .select_related("line__page")
        .order_by("line__page__page_number", "line__line_number", "segment_order")
    )

    spans: list[Span] = []
    chunk_start = start
    seen_lines: set[tuple[int, int]] = set()
    last_aya: tuple[int, int] | None = None
    for segment in rows:
        key = _key(segment.line)
        if not (_key(first_line) <= key <= _key(last_line)):
            continue
        # Both are filtered non-null by the queryset; the guard is for the type
        # checker, and for the day someone loosens that filter.
        if segment.line.sura_id is None or segment.aya_number is None:
            continue
        aya: tuple[int, int] = (segment.line.sura_id, segment.aya_number)
        if aya < start or aya > end:
            continue
        seen_lines.add(key)
        last_aya = aya
        if len(seen_lines) >= target_lines and aya < end:
            spans.append((chunk_start, aya))
            chunk_start = _next_aya(mushaf, aya)
            # The boundary line belongs to both chunks; the next one starts on it.
            seen_lines = {key}
    if last_aya is None:
        return [(start, end)]
    if chunk_start <= end:
        spans.append((chunk_start, end))
    return spans or [(start, end)]


def _next_aya(mushaf: Mushaf, aya: tuple[int, int]) -> tuple[int, int]:
    """The aya after this one, rolling into the next sura at a sura's end."""
    system = word_inputs.counting_system_for(mushaf)
    if aya[1] < words_service.sura_last_aya(system, aya[0]):
        return (aya[0], aya[1] + 1)
    return (aya[0] + 1, 1)


def run(
    mushaf: Mushaf,
    plan: RunPlan,
    *,
    user: User | None = None,
    on_progress: Callable[[int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> RunReport:
    """Walk the plan's chunks, detecting and storing each one.

    The cancel flag is read **between** chunks, never inside one: a half-written chunk
    would leave a line holding part of its words, and a stopped run is meant to settle
    with everything it finished already stored.

    No separator threshold, because from here there is nothing to threshold. Ornament
    positions were settled in the review phase and ``line_images`` hands them over, so
    ``split_separators`` skips both detectors entirely. The knob is live only for the
    CLI, where the engine is given a bare directory of images and has to find them.
    """
    lines_done = 0
    words_written = 0
    unresolved: list[str] = []

    for span_start, span_end in plan.spans:
        if cancelled is not None and cancelled():
            logger.info("Word run for mushaf %s cancelled after %d lines", mushaf.id, lines_done)
            return RunReport(lines_done, words_written, unresolved, cancelled=True)

        prepared = word_inputs.prepare_engine_input(mushaf.id, user=user, start=span_start, end=span_end)
        result = detect_words(prepared.source)
        stream = prepared.source.words
        saved = word_coordinates.save_word_coordinates(
            result,
            prepared.placements,
            # The span asked for, so a line that stopped resolving loses its old cuts.
            word_range=(stream[0].id or 0, stream[-1].id or 0),
        )

        lines_done += len(prepared.placements)
        words_written += saved.words_written
        unresolved += saved.unresolved
        if on_progress is not None:
            on_progress(lines_done)

    return RunReport(lines_done, words_written, unresolved)


def run_for_job(
    mushaf_id: uuid.UUID,
    plan: RunPlan,
    *,
    user: User | None,
    on_progress: Callable[[int], None],
    cancelled: Callable[[], bool],
) -> RunReport:
    """``run`` addressed by id, for a worker that only has the job row."""
    mushaf = Mushaf.objects.get(pk=mushaf_id)
    return run(mushaf, plan, user=user, on_progress=on_progress, cancelled=cancelled)

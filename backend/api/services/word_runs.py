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
``core.page_detection.pipeline`` makes between pages.

**Why aya spans and not page ranges.** The engine walks one cursor through the word
stream, so a chunk has to be a self-contained span it can start from word zero of.
``(sura, aya)`` is the only address that is, which is why ``prepare_engine_input``
takes one.

**Why a span may be any length, up to the whole mushaf.** Nothing about a sura is
special to the engine: it is handed lines and the words they hold, and a sura end is
just another ornament. So a run is planned over whatever ``(sura, aya)`` pair it is
given, and the same chunking carries it — 150-odd chunks for a whole mushaf instead
of one or two for a sura.

**Why a long span must be checked for holes.** One cursor walking one stream is also
the thing that makes a long run fragile. Hand it a span whose middle pages were never
processed and the words of those pages have no ink to land on, so every line after the
hole is read against the wrong words — silently, and confidently. Over one sura that
is a remote possibility; over a whole mushaf it is the normal state of a project part
way through review. So the plan **reads the span first** and cuts it at every break in
the aya sequence: each side becomes its own span with its own stream, the hole is
reported rather than walked through, and a run over a half-finished mushaf does the
part that is finished. See :func:`plan_spans`.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

from django.conf import settings
from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import Line, LineTypeChoices, Mushaf, ProcessJob, ProcessJobKindChoices, Segment
from api.services import line_images as line_images_service
from api.services import run_logs, word_coordinates, word_inputs
from core.word_boundary import (
    FLAGGED_STATUSES,
    STATUSES,
    WordBoundaryInput,
    WordBoundaryResult,
    as_dict,
    detect_words,
)
from quran.services import words as words_service

logger = logging.getLogger(__name__)

Span = tuple[tuple[int, int], tuple[int, int]]


@dataclass(frozen=True)
class SpanGap:
    """A break in the reading: two ayat that should be neighbours and are not.

    Either the pages between them were never processed, or they were processed and
    never renumbered — from here the two look the same and the consequence is the
    same, so they are reported the same way. What matters is that the words between
    ``after`` and ``before`` have no ink to land on, and a run must not try.
    """

    #: Last aya read before the break, and the first one read after it.
    after: tuple[int, int]
    before: tuple[int, int]
    #: The pages those two sit on. Everything strictly between is unreadable.
    after_page: int
    before_page: int
    #: Text lines inside the break that carry no aya number at all.
    unnumbered_lines: int

    def describe(self) -> str:
        return (
            f"{self.after[0]}:{self.after[1]} (page {self.after_page}) is followed by "
            f"{self.before[0]}:{self.before[1]} (page {self.before_page}) — the pages between were "
            f"never processed or never renumbered, so the run skips them"
        )

    def as_dict(self) -> dict:
        """The gap as JSON, for the API and the run report alike.

        One shape, written once: the two go out of the same door often enough that a
        reader comparing a stored report against a live response should not have to
        check whether the two agree.
        """
        return {
            "after": f"{self.after[0]}:{self.after[1]}",
            "before": f"{self.before[0]}:{self.before[1]}",
            "after_page": self.after_page,
            "before_page": self.before_page,
            "unnumbered_lines": self.unnumbered_lines,
        }


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
    #: Breaks in the reading the run steps over rather than through. Empty for the
    #: ordinary case of a span whose pages are all there.
    gaps: list[SpanGap] = field(default_factory=list)


@dataclass(frozen=True)
class RunReport:
    lines_done: int
    words_written: int
    unresolved: list[str] = field(default_factory=list)
    cancelled: bool = False
    #: Where this run's detailed log was written, relative to ``settings.LOG_DIR``.
    #: Empty when the run was driven without one — a test, or a direct call.
    log_path: str = ""
    #: First aya the run did **not** reach, set only when it was cancelled. A span
    #: long enough to be worth stopping is long enough to be worth resuming, and
    #: this is the only place the stopping point is known.
    resume_at: tuple[int, int] | None = None


def preflight(mushaf: Mushaf, start: tuple[int, int], end: tuple[int, int | None] | None) -> RunPlan:
    """Everything checkable while the caller can still be told.

    A background job's failures arrive long after the response has gone, so a bad
    span or an unset riwaya must be caught here or it becomes a *failed run* instead
    of a rejected request. The same reasoning as ``processing.preflight``.

    ``end`` may be given three ways, and the last two are resolved here rather than by
    the caller because only this side knows **this mushaf's** counting system — the
    last aya of a sura is not the same number in every riwaya:

    * ``(9, 129)`` — exactly that aya;
    * ``(9, None)`` — through the end of at-Tawba;
    * ``None`` — through the end of the sura the run *starts* in.
    """
    try:
        system = word_inputs.counting_system_for(mushaf)
    except LookupError as error:
        raise HttpError(422, i18n.t("words_no_riwaya")) from error

    last_ayat = words_service.sura_last_ayat(system)
    end_sura = start[0] if end is None else end[0]
    end_aya = end[1] if end is not None and end[1] is not None else _last_aya_of(last_ayat, end_sura)
    span_end: tuple[int, int] = (end_sura, end_aya)

    first = _locate(mushaf, start)
    last = _locate(mushaf, span_end, last=True)
    first_line, last_line = first.line, last.line
    if _key(last_line) < _key(first_line):
        raise HttpError(
            422,
            i18n.t(
                "words_span_backwards",
                from_sura=start[0],
                from_aya=start[1],
                to_sura=span_end[0],
                to_aya=span_end[1],
            ),
        )

    lines = _span_lines(mushaf, first_line, last_line)
    spans, gaps = plan_spans(
        mushaf,
        start,
        span_end,
        first_line=first_line,
        last_line=last_line,
        last_ayat=last_ayat,
        span_lines=lines,
    )
    warnings: list[str] = []
    symbols = line_images_service.symbol_templates(mushaf)
    if line_images_service.separator_template(mushaf) is None:
        warnings.append(
            "This mushaf has no aya separator template, so ornaments are found by shape alone. "
            "Cutting one from a page will make the anchors more reliable."
        )
    missing_symbols = sorted(set(line_images_service.SYMBOL_TEMPLATE_TYPES) - set(symbols))
    if missing_symbols:
        # A warning and not a refusal: most pages carry neither symbol, and a
        # mushaf processed before these templates existed must keep working. The
        # cost of running without one is confined to the lines that print it —
        # there the engine reads the symbol as letters and every word after it on
        # that line lands wrong.
        warnings.append(
            f"No {' or '.join(name.replace('_', ' ') for name in missing_symbols)} template is saved. "
            f"Lines printing that symbol will have its ink read as letters; capture it in the "
            f"Templates step and run those pages again."
        )
    if gaps:
        warnings.append(
            f"{len(gaps)} break(s) in this span were skipped, because the pages there are not "
            f"processed and renumbered — process them and run that part again."
        )
        warnings += [gap.describe() for gap in gaps]
    return RunPlan(
        start=start,
        end=span_end,
        spans=spans,
        total_lines=len(lines),
        first_page=first_line.page.page_number,
        last_page=last_line.page.page_number,
        warnings=warnings,
        gaps=gaps,
    )


def _last_aya_of(last_ayat: dict[int, int], sura: int) -> int:
    """This mushaf's last aya number for a sura, or a 422 naming the sura."""
    last = last_ayat.get(sura)
    if last is None:
        raise HttpError(422, i18n.t("words_span_not_found", sura=sura, aya=1))
    return last


def available_span(mushaf: Mushaf) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """The first and last aya this mushaf actually holds, or None if it holds none.

    What "the whole mushaf" resolves to. It is asked of the pages rather than of the
    counting system on purpose: a mushaf in progress is a few juz, a single-sura test
    file is one sura, and offering either of those ``1:1 .. 114:6`` would only produce
    a span whose two ends cannot be located.
    """
    rows = (
        Segment.objects.filter(
            line__page__mushaf=mushaf,
            line__type=LineTypeChoices.TEXT,
            aya_number__isnull=False,
            line__sura__isnull=False,
        )
        .select_related("line__page")
        .order_by("line__page__page_number", "line__line_number", "segment_order")
    )
    first = rows.first()
    last = rows.last()
    if first is None or last is None:
        return None
    return (first.line.sura_id, first.aya_number), (last.line.sura_id, last.aya_number)


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


def plan_spans(
    mushaf: Mushaf,
    start: tuple[int, int],
    end: tuple[int, int],
    *,
    target_lines: int = 60,
    first_line: Line | None = None,
    last_line: Line | None = None,
    last_ayat: dict[int, int] | None = None,
    span_lines: list[Line] | None = None,
) -> tuple[list[Span], list[SpanGap]]:
    """Read the span, cut it at every hole, then cut each piece into chunks.

    Two cuts, for two different reasons, which is why they are one pass:

    * **Holes** are cut because they *must* be. Between the aya before a hole and the
      aya after it lie words with no ink — pages never processed, or processed and
      never renumbered. The engine walks one cursor through one stream, so handing it
      such a span would not fail: it would quietly read every later line against the
      wrong words. Each side of a hole therefore becomes its own span, with its own
      stream, starting from word zero.
    * **Chunks** are cut because a long run needs progress and a place to stop. That
      is the ``target_lines`` split, and it is the older of the two — see the module
      docstring for why it buys nothing in speed.

    The reading is what finds the holes: walked in order, a span's ayat must each be
    the successor of the one before. Anything else is a break, whatever caused it.

    ``last_ayat`` and ``span_lines`` are passed in by :func:`preflight`, which has
    already paid for both; called alone, this fetches them itself.
    """
    first_line = first_line or _locate(mushaf, start).line
    last_line = last_line or _locate(mushaf, end, last=True).line
    if last_ayat is None:
        last_ayat = words_service.sura_last_ayat(word_inputs.counting_system_for(mushaf))

    entries = _read_span(mushaf, first_line, last_line, start, end)
    if not entries:
        # Nothing numbered in the span. One chunk is the honest answer: better one
        # long run than a split guessed from data that is not there.
        return [(start, end)], []

    islands = _islands(entries, last_ayat)
    gaps = _gaps(islands, span_lines if span_lines is not None else _span_lines(mushaf, first_line, last_line))

    spans: list[Span] = []
    for index, island in enumerate(islands):
        # The requested ends win over what the reading found: ``start`` and ``end``
        # were located as real segments, so a run asked for 2:5 begins there and not
        # at whatever aya the first segment row happened to carry.
        island_start = start if index == 0 else island[0].aya
        island_end = end if index == len(islands) - 1 else island[-1].aya
        spans += _chunk_island(island, island_start, island_end, target_lines, last_ayat)
    return spans or [(start, end)], gaps


def chunks(
    mushaf: Mushaf,
    start: tuple[int, int],
    end: tuple[int, int],
    *,
    target_lines: int = 60,
    first_line: Line | None = None,
    last_line: Line | None = None,
) -> list[Span]:
    """The spans a run will walk — :func:`plan_spans` without the gaps it found.

    Kept as its own name because that is what a caller who only wants to see the
    split asks for, and because a gap is a finding to *report* rather than an input
    to the walk: the spans already step around them.
    """
    return plan_spans(
        mushaf,
        start,
        end,
        target_lines=target_lines,
        first_line=first_line,
        last_line=last_line,
    )[0]


@dataclass(frozen=True)
class _Entry:
    """One numbered segment, as the planner needs it: where it sits, and its aya."""

    key: tuple[int, int]
    aya: tuple[int, int]

    @property
    def page(self) -> int:
        return self.key[0]


def _read_span(
    mushaf: Mushaf,
    first_line: Line,
    last_line: Line,
    start: tuple[int, int],
    end: tuple[int, int],
) -> list[_Entry]:
    """Every numbered segment of the span, in reading order.

    Segments rather than lines, because a line holds as many ayat as fit on it and
    the boundaries a chunk may be cut on are the ayat, not the lines.
    """
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
    low, high = _key(first_line), _key(last_line)
    entries: list[_Entry] = []
    for segment in rows:
        key = _key(segment.line)
        if not (low <= key <= high):
            continue
        # Both are filtered non-null by the queryset; the guard is for the type
        # checker, and for the day someone loosens that filter.
        if segment.line.sura_id is None or segment.aya_number is None:
            continue
        aya = (segment.line.sura_id, segment.aya_number)
        if aya < start or aya > end:
            continue
        entries.append(_Entry(key, aya))
    return entries


def _islands(entries: list[_Entry], last_ayat: dict[int, int]) -> list[list[_Entry]]:
    """Split the reading into stretches whose ayat run on without a break.

    A new aya must be the successor of the one before it — the next in the sura, or
    aya 1 of the next sura. Anything else means pages are missing between the two,
    and the two stretches cannot share a word stream.
    """
    islands: list[list[_Entry]] = []
    current: list[_Entry] = []
    previous: tuple[int, int] | None = None
    for entry in entries:
        repeated = entry.aya == previous
        if previous is not None and not repeated and entry.aya != words_service.next_aya(last_ayat, previous):
            islands.append(current)
            current = []
        current.append(entry)
        previous = entry.aya
    if current:
        islands.append(current)
    return islands


def _gaps(islands: list[list[_Entry]], span_lines: list[Line]) -> list[SpanGap]:
    """What lies between one island and the next, named so a user can go fix it.

    The unnumbered line count is the useful half: a break where the pages are missing
    entirely reads differently from one where they are there and the renumber walk
    has not reached them, and that count is what tells the two apart.
    """
    keys = [_key(line) for line in span_lines]
    gaps: list[SpanGap] = []
    for before_island, after_island in pairwise(islands):
        numbered = {entry.key for entry in before_island} | {entry.key for entry in after_island}
        low, high = before_island[-1].key, after_island[0].key
        gaps.append(
            SpanGap(
                after=before_island[-1].aya,
                before=after_island[0].aya,
                after_page=before_island[-1].page,
                before_page=after_island[0].page,
                unnumbered_lines=sum(1 for key in keys if low < key < high and key not in numbered),
            )
        )
    return gaps


def _chunk_island(
    entries: list[_Entry],
    start: tuple[int, int],
    end: tuple[int, int],
    target_lines: int,
    last_ayat: dict[int, int],
) -> list[Span]:
    """Cut one unbroken stretch into aya ranges of roughly ``target_lines`` lines.

    Cuts fall on aya boundaries because that is the only address the engine can start
    from. Two consecutive chunks therefore **share** the line the boundary falls on,
    each writing its own half of it — which is safe because ``LineWord`` carries no
    per-line rank to collide over and ``save_word_coordinates`` clears only its own
    word range.
    """
    spans: list[Span] = []
    chunk_start = start
    seen: set[tuple[int, int]] = set()
    for entry in entries:
        seen.add(entry.key)
        if len(seen) < target_lines or entry.aya >= end:
            continue
        following = words_service.next_aya(last_ayat, entry.aya)
        if following is None or following > end:
            continue
        spans.append((chunk_start, entry.aya))
        chunk_start = following
        # The boundary line belongs to both chunks; the next one starts on it.
        seen = {entry.key}
    if chunk_start <= end:
        spans.append((chunk_start, end))
    return spans


def run(
    mushaf: Mushaf,
    plan: RunPlan,
    *,
    user: User | None = None,
    on_progress: Callable[[int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    log: bool = False,
    on_log_started: Callable[[str], None] | None = None,
) -> RunReport:
    """Walk the plan's chunks, detecting and storing each one.

    The cancel flag is read **between** chunks, never inside one: a half-written chunk
    would leave a line holding part of its words, and a stopped run is meant to settle
    with everything it finished already stored.

    No separator threshold, because from here there is nothing to threshold. Ornament
    positions were settled in the review phase and ``line_images`` hands them over, so
    ``split_separators`` skips both detectors entirely. The knob is live only for the
    CLI, where the engine is given a bare directory of images and has to find them.

    ``log`` opens this run's own file and attaches it to the root logger for the
    duration, which is what captures the engine's trace — the engine narrates and
    knows nothing about files, so the *caller's* handler is the only thing that
    decides whether that trace is kept. Off by default: a test driving ``run``
    directly wants neither the file nor the several MB it costs. ``on_log_started``
    is called the moment the path is known, before any work, so a run that dies
    halfway is still traceable to its log.

    **A long run keeps a shorter log**, and a shorter report — see :func:`_detail`.
    """
    handler = None
    log_rel = ""
    report_to: Path | None = None
    full_detail = _detail(plan)
    if log:
        log_rel, log_path = run_logs.allocate()
        report_to = run_logs.report_path(log_path)
        handler = run_logs.attach(log_path, level=None if full_detail else "INFO")
        if on_log_started is not None:
            on_log_started(log_rel)
    try:
        return _run(
            mushaf,
            plan,
            user=user,
            on_progress=on_progress,
            cancelled=cancelled,
            log_rel=log_rel,
            report_to=report_to,
            full_detail=full_detail,
        )
    except Exception:
        # Logged here rather than left to the job wrapper, which only sees it after
        # this handler is gone — and a log that stops mid-chunk with no reason is
        # exactly the log somebody opens a crashed run to read.
        logger.exception("Word run failed")
        raise
    finally:
        if handler is not None:
            run_logs.detach(handler)


def _detail(plan: RunPlan) -> bool:
    """Whether this run is short enough to keep the full per-word evidence.

    DEBUG costs roughly 17 KB of log a line and the report another 250 bytes a word,
    which is the right trade for the run somebody is about to debug — a sura, a page,
    a span they are arguing with. A whole mushaf is 9,000-odd lines and 77,000 words:
    the same settings make a log of well over a hundred megabytes, kept thirty times
    over by ``RUN_LOG_RETENTION``, and a report Python has to hold in memory before it
    can write it.

    So past the threshold the run drops to INFO and the report keeps its verdicts
    without the per-word boxes. Nothing a reader needs to *find* a bad line is lost —
    the plan, every chunk, every line's status and reason, and every total survive.
    What goes is the evidence for lines nobody has asked about yet; a re-run over the
    sura that holds them brings it back.
    """
    limit = int(getattr(settings, "WORD_RUN_FULL_DETAIL_LINES", 1500))
    return limit <= 0 or plan.total_lines <= limit


def _run(
    mushaf: Mushaf,
    plan: RunPlan,
    *,
    user: User | None,
    on_progress: Callable[[int], None] | None,
    cancelled: Callable[[], bool] | None,
    log_rel: str,
    report_to: Path | None,
    full_detail: bool = True,
) -> RunReport:
    """The walk itself, with the log already attached (or not)."""
    started = time.perf_counter()
    _log_plan(mushaf, plan, full_detail=full_detail)

    lines_done = 0
    words_written = 0
    unresolved: list[str] = []
    chunk_reports: list[dict] = []

    for index, (span_start, span_end) in enumerate(plan.spans, start=1):
        if cancelled is not None and cancelled():
            logger.warning(
                "CANCELLED after %d of %d chunk(s) — %d line(s) and %d word(s) are written and stay written",
                index - 1,
                len(plan.spans),
                lines_done,
                words_written,
            )
            # Named so the run can be picked up where it stopped. A long run is
            # exactly the one somebody stops halfway, and re-reading the part that
            # is already stored is the cost of not saying this.
            logger.warning(
                "  to carry on from here, run %d:%d .. %d:%d",
                span_start[0],
                span_start[1],
                plan.end[0],
                plan.end[1],
            )
            _write_report(
                report_to,
                plan,
                chunk_reports,
                cancelled=True,
                resume_at=span_start,
            )
            return RunReport(
                lines_done,
                words_written,
                unresolved,
                cancelled=True,
                log_path=log_rel,
                resume_at=span_start,
            )

        logger.info("")
        logger.info("━" * 72)
        logger.info(
            "CHUNK %d/%d — %d:%d .. %d:%d",
            index,
            len(plan.spans),
            span_start[0],
            span_start[1],
            span_end[0],
            span_end[1],
        )
        logger.info("━" * 72)

        chunk_started = time.perf_counter()
        prepared = word_inputs.prepare_engine_input(mushaf.id, user=user, start=span_start, end=span_end)
        stream = prepared.source.words
        logger.info(
            "  cut %d line(s) from page(s) %d..%d, %d word(s) of text, ornaments %s",
            len(prepared.placements),
            prepared.placements[0].line.page.page_number if prepared.placements else 0,
            prepared.placements[-1].line.page.page_number if prepared.placements else 0,
            len(stream),
            "supplied by the review phase" if prepared.placements else "n/a",
        )
        for placed in prepared.placements:
            logger.debug(
                "    %s: page %d line %d, image %dx%d at page x=%d, %d ornament(s) supplied",
                placed.image.label,
                placed.line.page.page_number,
                placed.line.line_number,
                placed.image.image.width,
                placed.image.image.height,
                placed.origin_x,
                len(placed.image.separators or []),
            )

        result = detect_words(prepared.source)

        saved = word_coordinates.save_word_coordinates(
            result,
            prepared.placements,
            # The span asked for, so a line that stopped resolving loses its old cuts.
            word_range=(stream[0].id or 0, stream[-1].id or 0),
        )
        logger.info(
            "  stored: %d line(s) written, %d word(s), %d line(s) cleared first%s",
            saved.lines_written,
            saved.words_written,
            saved.lines_cleared,
            f", {saved.displaced} human cut(s) displaced" if saved.displaced else "",
        )
        if saved.unresolved:
            logger.warning(
                "  %d line(s) hold no words and are visibly empty: %s",
                len(saved.unresolved),
                ", ".join(saved.unresolved),
            )

        lines_done += len(prepared.placements)
        words_written += saved.words_written
        unresolved += saved.unresolved
        # ``as_dict`` already names the span it covered; what is added here is only
        # what the engine cannot know — how long it took and what was stored. Slimmed
        # here rather than at the end, so a long run never holds the full detail of
        # every chunk in memory waiting to be thrown away.
        chunk_reports.append(
            {
                "chunk": index,
                "seconds": round(time.perf_counter() - chunk_started, 3),
                "words_written": saved.words_written,
                "lines_cleared": saved.lines_cleared,
                "displaced": saved.displaced,
                **_chunk_detail(prepared.source, result, full_detail=full_detail),
            }
        )
        logger.info("  chunk done in %.2fs", time.perf_counter() - chunk_started)
        if on_progress is not None:
            on_progress(lines_done)

    _log_totals(plan, chunk_reports, lines_done, words_written, unresolved, time.perf_counter() - started)
    _write_report(report_to, plan, chunk_reports, cancelled=False)
    return RunReport(lines_done, words_written, unresolved, log_path=log_rel)


def _chunk_detail(source: WordBoundaryInput, result: WordBoundaryResult, *, full_detail: bool) -> dict:
    """One chunk as report data, at the detail this run can afford.

    The slim form **drops** each line's ``words`` and ``ornaments`` lists — the two
    that grow with the text rather than with the number of lines, and between them
    nearly all of the file — and puts a ``word_count`` in their place. Dropped rather
    than replaced by a number under the same key, so nothing reading a report can find
    a count where it expected a list; ``detail`` says which form this is.

    Every line still carries its label, status, reason, cost and counts, so the report
    remains the thing you grep to find a bad line. It simply stops being the thing you
    read the evidence out of. See :func:`_detail`.
    """
    payload = as_dict(source, result)
    payload["detail"] = "full" if full_detail else "summary"
    if full_detail:
        return payload
    for line in payload["lines"]:
        line["word_count"] = len(line.pop("words"))
        line.pop("ornaments", None)
    return payload


def _log_plan(mushaf: Mushaf, plan: RunPlan, *, full_detail: bool = True) -> None:
    """Everything settled before the first line is read.

    A run that goes wrong is nearly always a run that was asked for the wrong thing,
    so the request and the plan it became are the first thing in the file.

    The gaps are listed before the chunks rather than after, because on a long span
    they are the reason the chunk list looks the way it does — a reader who meets the
    chunks first spends a while wondering why one of them jumps forty pages.
    """
    logger.info("═" * 72)
    logger.info("WORD RUN — %s", mushaf.name)
    logger.info("═" * 72)
    logger.info("  span        %d:%d .. %d:%d", plan.start[0], plan.start[1], plan.end[0], plan.end[1])
    logger.info("  pages       %d .. %d", plan.first_page, plan.last_page)
    logger.info("  lines       %d text line(s)", plan.total_lines)
    logger.info("  chunks      %d", len(plan.spans))
    logger.info("  riwaya      %s", mushaf.rawi.name if mushaf.rawi else "(none)")
    if not full_detail:
        # Said here because this is where somebody looks when the evidence they came
        # for is missing, and a log that silently omits it is worse than a short one.
        logger.info(
            "  detail      summary only — %d lines is past WORD_RUN_FULL_DETAIL_LINES, so the "
            "per-component and per-word evidence is left out of this log and its report. "
            "Re-run a single sura to get it back.",
            plan.total_lines,
        )
    if plan.gaps:
        logger.warning("  gaps        %d break(s) in the reading, stepped over:", len(plan.gaps))
        for gap in plan.gaps:
            logger.warning(
                "    %d:%d (page %d) → %d:%d (page %d), %d unnumbered line(s) between",
                gap.after[0],
                gap.after[1],
                gap.after_page,
                gap.before[0],
                gap.before[1],
                gap.before_page,
                gap.unnumbered_lines,
            )
    for index, (span_start, span_end) in enumerate(plan.spans, start=1):
        logger.info(
            "    chunk %-3d %d:%d .. %d:%d",
            index,
            span_start[0],
            span_start[1],
            span_end[0],
            span_end[1],
        )
    for warning in plan.warnings:
        logger.warning("  %s", warning)


def _log_totals(
    plan: RunPlan,
    chunks: list[dict],
    lines_done: int,
    words_written: int,
    unresolved: list[str],
    seconds: float,
) -> None:
    """The run as one table — what the reviewer reads before opening a page."""
    totals = {status: sum(chunk["totals"][status] for chunk in chunks) for status in STATUSES}
    logger.info("")
    logger.info("═" * 72)
    logger.info("RUN FINISHED — %d line(s) in %.1fs", lines_done, seconds)
    logger.info("═" * 72)
    logger.info("  span        %d:%d .. %d:%d", plan.start[0], plan.start[1], plan.end[0], plan.end[1])
    logger.info("  words       %d written", words_written)
    logger.info(
        "  verdicts    %d exact, %d scored, %d partial, %d unresolved",
        totals["exact"],
        totals["scored"],
        totals["partial"],
        totals["unresolved"],
    )
    flagged = sum(totals[status] for status in FLAGGED_STATUSES)
    logger.info(
        "  review      %d of %d line(s) are worth a look (%.0f%%)",
        flagged,
        lines_done,
        100 * flagged / max(1, lines_done),
    )
    incomplete = [chunk for chunk in chunks if not chunk["complete"]]
    if incomplete:
        logger.warning(
            "  %d chunk(s) did not account for their whole span: %s",
            len(incomplete),
            ", ".join(f"{chunk['span']['from']}..{chunk['span']['to']}" for chunk in incomplete),
        )
    if unresolved:
        logger.warning("  %d line(s) hold no words: %s", len(unresolved), ", ".join(unresolved))
    logger.info("═" * 72)


def _write_report(
    path: Path | None,
    plan: RunPlan,
    chunks: list[dict],
    *,
    cancelled: bool,
    resume_at: tuple[int, int] | None = None,
) -> None:
    """Drop the machine-readable twin of the log beside it.

    Written even for a cancelled run: the chunks that finished are real results and
    a stopped run is exactly the one you want to inspect. Best-effort — failing to
    write the report must never fail a run whose words are already stored.
    """
    if path is None:
        return
    payload = {
        "span": {"from": f"{plan.start[0]}:{plan.start[1]}", "to": f"{plan.end[0]}:{plan.end[1]}"},
        "pages": {"first": plan.first_page, "last": plan.last_page},
        "total_lines": plan.total_lines,
        "warnings": plan.warnings,
        "gaps": [gap.as_dict() for gap in plan.gaps],
        "cancelled": cancelled,
        "resume_at": f"{resume_at[0]}:{resume_at[1]}" if resume_at else None,
        "chunks": chunks,
    }
    try:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        logger.warning("Could not write the run report to %s", path, exc_info=True)


def run_for_job(
    mushaf_id: uuid.UUID,
    plan: RunPlan,
    *,
    user: User | None,
    on_progress: Callable[[int], None],
    cancelled: Callable[[], bool],
    job_id: uuid.UUID | None = None,
) -> RunReport:
    """``run`` addressed by id, for a worker that only has the job row.

    This is the path that keeps a log, because it is the only one with somewhere to
    record it: ``job_id`` names the row that will point at the file, and the pointer
    is written the moment the path is minted rather than at the end, so a run that
    crashes halfway still leads to the trace of how it got there.
    """
    mushaf = Mushaf.objects.get(pk=mushaf_id)

    def remember(log_rel: str) -> None:
        if job_id is not None:
            ProcessJob.objects.filter(pk=job_id).update(
                log_path=log_rel,
                log_url=f"/api/mushafs/{mushaf_id}/words/jobs/{job_id}/log",
            )

    return run(
        mushaf,
        plan,
        user=user,
        on_progress=on_progress,
        cancelled=cancelled,
        log=job_id is not None,
        on_log_started=remember,
    )


# ----------------------------------------------------------------------
# Reading a run's log back
# ----------------------------------------------------------------------


def log_file(mushaf: Mushaf, job_id: uuid.UUID) -> Path:
    """Validated path to a word run's detailed log (404 if missing or foreign).

    Scoped to the mushaf, so a job id from somebody else's mushaf is a 404 rather
    than a file — the same rule ``processing.run_log_file`` follows for detection.
    """
    log_rel = (
        ProcessJob.objects.filter(pk=job_id, mushaf=mushaf, kind=ProcessJobKindChoices.WORDS)
        .values_list("log_path", flat=True)
        .first()
    )
    if not log_rel:
        raise HttpError(404, i18n.t("run_no_log"))
    path = run_logs.resolve(log_rel)
    if path is None:
        raise HttpError(404, i18n.t("log_not_found"))
    return path


def report_file(mushaf: Mushaf, job_id: uuid.UUID) -> Path:
    """The JSON twin of that log. 404 while the run is still writing it.

    The report is written once, when the run settles; the log exists from the first
    line. So a poll during a run finds the log and not yet the report, which is the
    honest answer rather than an empty file.
    """
    path = run_logs.report_path(log_file(mushaf, job_id))
    if not path.is_file():
        raise HttpError(404, i18n.t("log_not_found"))
    return path


def read_log_tail(mushaf: Mushaf, job_id: uuid.UUID, offset: int = 0) -> dict:
    """Read a word run's log forward from ``offset`` — what the live viewer polls."""
    return run_logs.tail(log_file(mushaf, job_id), offset)

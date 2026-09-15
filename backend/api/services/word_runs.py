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
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import Line, LineTypeChoices, Mushaf, ProcessJob, ProcessJobKindChoices, Segment
from api.services import line_images as line_images_service
from api.services import run_logs, word_coordinates, word_inputs
from core.word_boundary import FLAGGED_STATUSES, STATUSES, as_dict, detect_words
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
    #: Where this run's detailed log was written, relative to ``settings.LOG_DIR``.
    #: Empty when the run was driven without one — a test, or a direct call.
    log_path: str = ""


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
    """
    handler = None
    log_rel = ""
    report_to: Path | None = None
    if log:
        log_rel, log_path = run_logs.allocate()
        report_to = run_logs.report_path(log_path)
        handler = run_logs.attach(log_path)
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


def _run(
    mushaf: Mushaf,
    plan: RunPlan,
    *,
    user: User | None,
    on_progress: Callable[[int], None] | None,
    cancelled: Callable[[], bool] | None,
    log_rel: str,
    report_to: Path | None,
) -> RunReport:
    """The walk itself, with the log already attached (or not)."""
    started = time.perf_counter()
    _log_plan(mushaf, plan)

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
            _write_report(report_to, plan, chunk_reports, cancelled=True)
            return RunReport(lines_done, words_written, unresolved, cancelled=True, log_path=log_rel)

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
        # what the engine cannot know — how long it took and what was stored.
        chunk_reports.append(
            {
                "chunk": index,
                "seconds": round(time.perf_counter() - chunk_started, 3),
                "words_written": saved.words_written,
                "lines_cleared": saved.lines_cleared,
                "displaced": saved.displaced,
                **as_dict(prepared.source, result),
            }
        )
        logger.info("  chunk done in %.2fs", time.perf_counter() - chunk_started)
        if on_progress is not None:
            on_progress(lines_done)

    _log_totals(plan, chunk_reports, lines_done, words_written, unresolved, time.perf_counter() - started)
    _write_report(report_to, plan, chunk_reports, cancelled=False)
    return RunReport(lines_done, words_written, unresolved, log_path=log_rel)


def _log_plan(mushaf: Mushaf, plan: RunPlan) -> None:
    """Everything settled before the first line is read.

    A run that goes wrong is nearly always a run that was asked for the wrong thing,
    so the request and the plan it became are the first thing in the file.
    """
    logger.info("═" * 72)
    logger.info("WORD RUN — %s", mushaf.name)
    logger.info("═" * 72)
    logger.info("  span        %d:%d .. %d:%d", plan.start[0], plan.start[1], plan.end[0], plan.end[1])
    logger.info("  pages       %d .. %d", plan.first_page, plan.last_page)
    logger.info("  lines       %d text line(s)", plan.total_lines)
    logger.info("  chunks      %d", len(plan.spans))
    logger.info("  riwaya      %s", mushaf.rawi.name if mushaf.rawi else "(none)")
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


def _write_report(path: Path | None, plan: RunPlan, chunks: list[dict], *, cancelled: bool) -> None:
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
        "cancelled": cancelled,
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

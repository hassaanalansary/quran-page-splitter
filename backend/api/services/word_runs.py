"""Settle a span of ayat before calibration processes it.

A page is calibrated as the span of ayat it holds — ``calibration.find_aya_span_of_page``
works that span out — and the engine walks one cursor through that span's words, so
the span has to resolve to real lines of this mushaf before a job is registered for
it. That is all this module does now: the run itself is ``calibration.process_page``.

**Why aya spans and not page ranges.** The engine walks one cursor through the word
stream, so a span has to be a self-contained stretch it can start from word zero of.
``(sura, aya)`` is the only address that is, which is why ``prepare_engine_input``
takes one.
"""

from __future__ import annotations

from dataclasses import dataclass

from ninja.errors import HttpError

from api import i18n
from api.models import Line, LineTypeChoices, Mushaf, Segment
from api.services import line_images as line_images_service
from api.services import word_inputs
from quran.services import words as words_service


@dataclass(frozen=True)
class RunPlan:
    """What a run is about to do, settled before it starts."""

    start: tuple[int, int]
    end: tuple[int, int]
    total_lines: int
    first_page: int
    last_page: int


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

    first_line = _locate(mushaf, start).line
    last_line = _locate(mushaf, span_end, last=True).line
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

    return RunPlan(
        start=start,
        end=span_end,
        total_lines=len(_span_lines(mushaf, first_line, last_line)),
        first_page=first_line.page.page_number,
        last_page=last_line.page.page_number,
    )


def _last_aya_of(last_ayat: dict[int, int], sura: int) -> int:
    """This mushaf's last aya number for a sura, or a 422 naming the sura."""
    last = last_ayat.get(sura)
    if last is None:
        raise HttpError(422, i18n.t("words_span_not_found", sura=sura, aya=1))
    return last


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

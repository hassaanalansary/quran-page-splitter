"""Writes the row of a new job. The step between the admission rules and the dispatch."""

from __future__ import annotations

from typing import Any

from accounts.models import User
from api.models import Mushaf, ProcessJob

#: The first and the last aya of a span, each as ``(sura, aya)``.
AyaSpan = tuple[tuple[int, int], tuple[int, int]]


def create_queued_job(
    *,
    kind: str,
    mushaf: Mushaf,
    requested_by: User | None,
    params: dict[str, Any],
    first_page: int,
    last_page: int,
    total: int,
    current_page: int | None = None,
    lines_done: int | None = None,
    aya_span: AyaSpan | None = None,
    report: dict | None = None,
) -> ProcessJob:
    """Create the row of one job in the ``queued`` state, ready to be dispatched.

    The row is all a worker gets, so it has to describe the whole job: ``kind`` picks
    the runner (``runner_registry``), and ``params`` holds the runner's inputs. They
    are stored as JSON, so they hold plain values only.

    ``total`` is what the job counts towards: pages for detection and for a
    calibration batch, lines for one calibration page. ``lines_done`` starts at 0 for
    a job that counts lines and stays null for one that counts pages. ``aya_span`` is
    given by a job that was asked for a span of ayat. Detection leaves it out and
    reports where it ended when it settles.
    """
    span_start, span_end = aya_span if aya_span is not None else ((None, None), (None, None))
    return ProcessJob.objects.create(
        kind=kind,
        mushaf=mushaf,
        requested_by=requested_by,
        params=params,
        page_range_start=first_page,
        page_range_end=last_page,
        total=total,
        current_page=current_page,
        lines_done=lines_done,
        start_sura=span_start[0],
        start_aya=span_start[1],
        end_sura=span_end[0],
        end_aya=span_end[1],
        report=report,
    )

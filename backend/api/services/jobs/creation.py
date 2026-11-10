"""Writes the row of a new job. The step between the admission rules and the dispatch."""

from __future__ import annotations

from django.utils import timezone

from accounts.models import User
from api.models import Mushaf, ProcessJob

#: The first and the last aya of a span, each as ``(sura, aya)``.
AyaSpan = tuple[tuple[int, int], tuple[int, int]]


def create_queued_job(
    *,
    kind: str,
    mushaf: Mushaf,
    requested_by: User | None,
    first_page: int,
    last_page: int,
    total: int,
    current_page: int | None = None,
    lines_done: int | None = None,
    aya_span: AyaSpan | None = None,
    report: dict | None = None,
) -> ProcessJob:
    """Create the row of one job, ready to be dispatched.

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
        started_by=requested_by,
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
        # Alive from the moment it exists. A job that dies before its first progress
        # tick then still ages out, and does not block its mushaf for good.
        heartbeat_at=timezone.now(),
    )

"""Word-boundary endpoints: run the engine, read what it found, correct it by hand.

The run is a background job for the same reason detection is — measured, a whole sura
is ~20s and al-Baqarah ~90s, which is past what a request should hold open. ``POST``
returns as soon as the job is registered; the client polls.

The read and fix sides are page-at-a-time, matching review and finalize, because that
is how a person works through a mushaf.
"""

import uuid

from django.http import FileResponse, HttpRequest
from ninja import Router, Schema
from pydantic import Field

from api.auth import current_user
from api.models import ActivityTypeChoices, Mushaf, ProcessJobKindChoices
from api.services import activity as activity_service
from api.services import jobs as jobs_service
from api.services import mushaf as mushaf_service
from api.services import word_coordinates, word_inputs, word_runs
from api.views.processing import JobOut, JobStatusOut, RunLogTailOut
from quran.models import CountingSystem

router = Router(tags=["words"])


class DetectWordsIn(Schema):
    """The span to read, as ``(sura, aya)`` at each end.

    **Any span, up to the whole mushaf.** The two ends are independent, so a run may
    cover part of a sura, a sura, or every sura the mushaf holds — nothing about a
    sura boundary is special to the engine, and the chunking is the same either way.

    Both halves of the end may be omitted, and each omission means something
    different, because only the server knows this mushaf's counting system:

    * no ``to_*`` — through the end of the sura the run starts in, the old default
      and still the common case;
    * ``to_sura`` alone — through the end of *that* sura;
    * both — exactly that aya.

    ``from_aya`` defaults to 1, so ``{"from_sura": 2, "to_sura": 5}`` is "al-Baqara
    through al-Ma'ida". For the whole mushaf, ask ``GET /words/span`` what it holds
    and send those two ends: a mushaf in progress rarely runs 1:1 .. 114:6, and a span
    whose ends are not on a page cannot be located.
    """

    from_sura: int = Field(ge=1, le=114)
    from_aya: int = Field(default=1, ge=1)
    to_sura: int | None = Field(default=None, ge=1, le=114)
    to_aya: int | None = Field(default=None, ge=1)


class SpanGapOut(Schema):
    """A break the run steps over rather than through — see ``word_runs.SpanGap``."""

    #: "2:281" — the last aya read before the break, and the first one after it.
    after: str
    before: str
    after_page: int
    before_page: int
    unnumbered_lines: int


class DetectWordsOut(Schema):
    job: JobOut
    #: Chunks the run was split into — what the progress bar is counting through.
    chunks: int
    total_lines: int
    #: Not reasons to refuse; things the user would want to know anyway.
    warnings: list[str] = Field(default_factory=list)
    #: Stretches of the span with no pages behind them. Empty for the ordinary case;
    #: on a long span this is what says *which* part of the mushaf was skipped, and
    #: the run did everything else.
    gaps: list[SpanGapOut] = Field(default_factory=list)


class SpanPointOut(Schema):
    sura: int
    aya: int


class MushafSpanOut(Schema):
    """The widest span this mushaf can be asked for — what "whole mushaf" means here.

    ``null`` at both ends when nothing on the mushaf is numbered yet, which is the
    state of a mushaf that has been processed but never renumbered. Offering
    ``1:1 .. 114:6`` there would only produce a run whose ends cannot be located.
    """

    start: SpanPointOut | None = None
    end: SpanPointOut | None = None


class WordIn(Schema):
    """One cut as a client sends it: where it falls, and who it belongs to.

    There is no ``position`` here on purpose. A line's words arrive as a list, and
    **that list's order is the reading order** — saying it twice would only create a
    second thing to keep true. See ``replace_page_words``.
    """

    #: Null where this mushaf carries a word the stored text does not have. The cut
    #: is the product; the label is optional.
    word_id: int | None = None
    #: The word's RIGHT edge, and so the LARGER of the two — Arabic runs right to
    #: left, and a word starts where it starts being read.
    start_x: int
    end_x: int


class WordOut(WordIn):
    """One cut as it goes out, with enough to judge it by.

    ``text`` and ``aya`` are display only and deliberately absent from ``WordIn``:
    they are derived from ``word_id``, so accepting them back would create a second
    place the same fact is written. Both are empty for an unlabelled row, and for a
    mushaf with no riwaya set — which has no answer to "which aya is this".

    ``position`` is the stored slot. The list is already in that order, so it is here
    to be *shown* — a reviewer looking at a line whose cuts sit out of order needs to
    see which word is which.
    """

    position: int = 0
    text: str = ""
    #: "7:82".
    aya: str = ""


class LineWordsOut(Schema):
    line_id: uuid.UUID
    line_number: int
    #: exact | scored | partial | unresolved, or null if never run.
    status: str | None = None
    reason: str = ""
    deviations: int = 0
    ties: int = 0
    edited: bool = False
    words: list[WordOut] = Field(default_factory=list)


class CoherenceIssueOut(Schema):
    kind: str
    detail: str
    line_number: int | None = None
    words: list[int] = Field(default_factory=list)


class PageWordsOut(Schema):
    page: int
    lines: list[LineWordsOut]
    issues: list[CoherenceIssueOut] = Field(default_factory=list)


class LineWordsIn(Schema):
    line_id: uuid.UUID
    words: list[WordIn]


class PageWordsIn(Schema):
    lines: list[LineWordsIn]


class PageCoverageOut(Schema):
    page: int
    text_lines: int
    lines_with_words: int
    words: int
    #: Lines the engine was not confident about, so a reviewer knows where to look.
    needs_review: int
    complete: bool


class CoverageOut(Schema):
    pages: list[PageCoverageOut]
    #: True when every text line of every processed page holds words.
    complete: bool


@router.post("/{mushaf_id}/words", response={202: DetectWordsOut})
def detect_words(request: HttpRequest, mushaf_id: uuid.UUID, data: DetectWordsIn) -> tuple[int, dict]:
    """Start word detection over a span of ayat; returns at once with the job.

    Everything that can be rejected must be rejected here. Once the job is registered
    the response has gone, and a missing riwaya or an unreviewed page would surface as
    a failed run rather than a fixable answer.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    start = (data.from_sura, data.from_aya)
    # ``to_sura`` alone is a span through the end of that sura, not a span of the
    # start sura — the older reading of this line dropped a multi-sura request on
    # the floor and ran one sura instead, silently.
    end = (data.to_sura, data.to_aya) if data.to_sura else None

    # Busy first, then the span: "a run is already going" is the more useful answer
    # even when the request is also wrong, and it is the cheaper check.
    jobs_service.ensure_idle(mushaf.id)
    plan = word_runs.preflight(mushaf, start, end)
    job = jobs_service.start_words(mushaf, plan, user=current_user(request))
    return 202, {
        "job": jobs_service.to_dict(job),
        "chunks": len(plan.spans),
        "total_lines": plan.total_lines,
        "warnings": plan.warnings,
        "gaps": [gap.as_dict() for gap in plan.gaps],
    }


@router.get("/{mushaf_id}/words/span", response=MushafSpanOut)
def words_span(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """The first and last aya this mushaf holds — what a "whole mushaf" run resolves to.

    Asked of the pages rather than of the counting system, because a mushaf in
    progress is a few juz and a test file is one sura. The client turns this into an
    ordinary ``from``/``to`` request, so the job row still records a real span and the
    server keeps no second meaning for an empty one.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    span = word_runs.available_span(mushaf)
    if span is None:
        return {"start": None, "end": None}
    (first_sura, first_aya), (last_sura, last_aya) = span
    return {
        "start": {"sura": first_sura, "aya": first_aya},
        "end": {"sura": last_sura, "aya": last_aya},
    }


@router.get("/{mushaf_id}/words/job", response=JobStatusOut)
def words_job(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """This mushaf's current or most recent word run — the polling endpoint.

    Filtered to word runs, so a detection run in flight is not mistaken for this one.
    """
    job = jobs_service.latest_for(mushaf_id, kind=ProcessJobKindChoices.WORDS)
    return {"job": jobs_service.to_dict(job) if job else None}


@router.post("/{mushaf_id}/words/cancel", response=JobOut)
def cancel_words(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Ask the running word job to stop; 404 when none is running.

    It stops at the next chunk boundary, never inside one — a half-written chunk would
    leave a line holding some of its words. Everything already stored stays stored.
    """
    job = jobs_service.request_cancel(mushaf_id, kind=ProcessJobKindChoices.WORDS, message="no_active_word_run")
    return jobs_service.to_dict(job)


@router.get("/{mushaf_id}/words/jobs/{job_id}/log")
def words_log(request: HttpRequest, mushaf_id: uuid.UUID, job_id: uuid.UUID) -> FileResponse:
    """A word run's detailed log as plain text — the whole file.

    Addressed by **job**, not by a run row: a word run creates none. It writes
    ``LineWord`` rows straight onto lines that already exist, so the job is the only
    thing that exists for exactly the life of the run.

    Streamed rather than read into memory, which detection's equivalent can afford
    and this one cannot: a whole-sura trace is a few MB and al-Baqara around 17.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    path = word_runs.log_file(mushaf, job_id)
    return FileResponse(path.open("rb"), content_type="text/plain; charset=utf-8")


@router.get("/{mushaf_id}/words/jobs/{job_id}/log/tail", response=RunLogTailOut)
def words_log_tail(
    request: HttpRequest,
    mushaf_id: uuid.UUID,
    job_id: uuid.UUID,
    offset: int = 0,
) -> dict:
    """Read a word run's log forward from ``offset`` — what the live viewer polls.

    Separate from ``/log`` (a whole-file download) because a viewer watching a run in
    flight wants only what it has not seen yet. Byte-for-byte the same contract
    detection's tail endpoint offers, so one component reads either.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return word_runs.read_log_tail(mushaf, job_id, offset)


@router.get("/{mushaf_id}/words/jobs/{job_id}/report")
def words_report(request: HttpRequest, mushaf_id: uuid.UUID, job_id: uuid.UUID) -> FileResponse:
    """The run as JSON: every line, its verdict, and every word the engine placed.

    The log's machine-readable twin, written when the run settles — so this is a 404
    while one is still going, which is the honest answer rather than a partial file.
    Served as an attachment because it is an artefact to keep and compare, not a page
    to read in a browser.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    path = word_runs.report_file(mushaf, job_id)
    return FileResponse(path.open("rb"), as_attachment=True, filename=path.name, content_type="application/json")


@router.get("/{mushaf_id}/words/coverage", response=CoverageOut)
def coverage(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Which pages have words, and how many of their lines still want a look.

    Answers "is this processed at all" without a stored flag: re-processing a page
    deletes its lines and takes their words with them, so a page that has gone stale
    reports as having none, which is the truth.
    """
    mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    pages = word_coordinates.coverage(mushaf_id)
    return {"pages": pages, "complete": bool(pages) and all(page["complete"] for page in pages)}


def _counting_system(mushaf: Mushaf) -> CountingSystem | None:
    """This mushaf's counting system, or None when it has no riwaya set.

    Reading a page is not running one. ``counting_system_for`` raises so that a
    *run* is refused rather than started blind, but both page endpoints hand the
    result to functions that already take ``None`` — so letting it out here would
    turn "no riwaya yet" into a 500 on a page that is otherwise perfectly readable.
    The aya labels and the anchor check are simply absent.
    """
    try:
        return word_inputs.counting_system_for(mushaf)
    except LookupError:
        return None


@router.get("/{mushaf_id}/pages/{page_number}/words", response=PageWordsOut)
def page_words(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> dict:
    """One page's lines, their cuts in reading order, and the engine's verdict."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    page = mushaf_service.get_page(mushaf, page_number)
    system = _counting_system(mushaf)
    return {
        "page": page.page_number,
        "lines": word_coordinates.page_words(page, system),
        "issues": [issue.__dict__ for issue in word_coordinates.coherence(page, system)],
    }


@router.put("/{mushaf_id}/pages/{page_number}/words", response=PageWordsOut)
def save_page_words(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: PageWordsIn) -> dict:
    """Replace the words of the named lines — the manual fix.

    Whole lines rather than single rows, because the errors that matter move a word
    *between* lines: read one mark as a letter and the engine spends a word too many,
    shifting everything after it across the line break. Send both lines and the move
    is one transaction, with no moment where the word is on both or on neither.

    Breaks are saved, not refused — a reviewer correcting line 10 before line 11 goes
    through an incoherent state on purpose. The report says what is broken.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    page = mushaf_service.get_page(mushaf, page_number)
    system = _counting_system(mushaf)
    report = word_coordinates.replace_page_words(
        page,
        [line.model_dump() for line in data.lines],
        counting_system=system,
    )
    # After the write, so the feed never claims an edit the transaction rolled back.
    activity_service.emit(
        mushaf,
        ActivityTypeChoices.WORDS_EDITED,
        {
            "page_number": page.page_number,
            "lines": report.lines_written,
            "words": report.words_written,
            "issues": len(report.issues),
        },
        actor=current_user(request),
    )
    return {
        "page": page.page_number,
        "lines": word_coordinates.page_words(page, system),
        "issues": [issue.__dict__ for issue in report.issues],
    }

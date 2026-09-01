"""Word-boundary endpoints: run the engine, read what it found, correct it by hand.

The run is a background job for the same reason detection is — measured, a whole sura
is ~20s and al-Baqarah ~90s, which is past what a request should hold open. ``POST``
returns as soon as the job is registered; the client polls.

The read and fix sides are page-at-a-time, matching review and finalize, because that
is how a person works through a mushaf.
"""

import uuid

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from api.auth import current_user
from api.models import ProcessJobKindChoices
from api.services import jobs as jobs_service
from api.services import mushaf as mushaf_service
from api.services import word_coordinates, word_inputs, word_runs
from api.views.processing import JobOut, JobStatusOut

router = Router(tags=["words"])


class DetectWordsIn(Schema):
    """The span to read, as ``(sura, aya)`` at each end.

    ``to_*`` may be omitted: a sura is the natural unit of a run, so the end defaults
    to that sura's last aya *in this mushaf's counting system* — which is not the same
    aya number in every riwaya, and is exactly why it is resolved server-side.
    """

    from_sura: int = Field(ge=1, le=114)
    from_aya: int = Field(ge=1)
    to_sura: int | None = Field(default=None, ge=1, le=114)
    to_aya: int | None = Field(default=None, ge=1)


class DetectWordsOut(Schema):
    job: JobOut
    #: Chunks the run was split into — what the progress bar is counting through.
    chunks: int
    total_lines: int
    #: Not reasons to refuse; things the user would want to know anyway.
    warnings: list[str] = Field(default_factory=list)


class WordOut(Schema):
    #: Null where this mushaf carries a word the stored text does not have. The cut
    #: is the product; the label is optional.
    word_id: int | None = None
    end_x: int


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
    words: list[WordOut]


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
    end = (data.to_sura, data.to_aya) if data.to_sura and data.to_aya else None

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


@router.get("/{mushaf_id}/pages/{page_number}/words", response=PageWordsOut)
def page_words(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> dict:
    """One page's lines, their cuts in reading order, and the engine's verdict."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    page = mushaf_service.get_page(mushaf, page_number)
    return {
        "page": page.page_number,
        "lines": word_coordinates.page_words(page),
        "issues": [
            issue.__dict__ for issue in word_coordinates.coherence(page, word_inputs.counting_system_for(mushaf))
        ],
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
    system = word_inputs.counting_system_for(mushaf)
    report = word_coordinates.replace_page_words(
        page,
        [line.model_dump() for line in data.lines],
        counting_system=system,
    )
    return {
        "page": page.page_number,
        "lines": word_coordinates.page_words(page),
        "issues": [issue.__dict__ for issue in report.issues],
    }

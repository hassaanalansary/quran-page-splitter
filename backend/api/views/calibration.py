"""Calibration endpoints: process a page, correct it, preview, confirm, evaluate.

Page-at-a-time like review and the word cuts, because that is how a person works:
one page processed, reviewed and confirmed before the next is read from it. See
``api.services.calibration`` for the loop and what each step stores.

The page document is large — every blob of every line, about a thousand to a page —
so it goes out through ``JsonResponse`` rather than a response schema, the same
choice ``review-data`` makes: re-validating it would cost more than producing it.
What comes *in* is validated here in full.
"""

import uuid

from django.http import HttpRequest, JsonResponse
from ninja import Router, Schema
from pydantic import Field

from api.auth import current_user
from api.models import ProcessJobKindChoices
from api.services import calibration as calibration_service
from api.services import calibration_batch as batch_service
from api.services import calibration_progress as progress_service
from api.services import jobs as jobs_service
from api.services import mushaf as mushaf_service
from api.views.processing import JobOut, JobStatusOut

router = Router(tags=["calibration"])

#: Calibration's two kinds of job, polled and cancelled from the one screen: a page
#: processed on its own, and a batch of pages. One runs at a time, as for every kind.
CALIBRATION_JOBS = (ProcessJobKindChoices.CALIBRATION, ProcessJobKindChoices.CALIBRATION_BATCH)


class AllocationIn(Schema):
    """A blob's share of one word: how many of that word's PAWs it carries.

    ``paws`` is 1 for an ordinary body, 0 for a broken fragment of a letter, 2 for
    two bodies printed touching in one word — and always 0 for a mark.
    """

    word_id: int
    paws: int = Field(ge=0, le=calibration_service.MAX_PAWS)


class BlobEditIn(Schema):
    id: int
    #: body | mark for text; an ornament or a symbol keeps its own role.
    role: str
    #: The reviewer decided this role: a hard constraint from now on.
    explicit: bool = False
    #: The reviewer decided these allocations. Omitted means "changed if different".
    ownership_explicit: bool | None = None
    subtype: str = Field(default="", max_length=32)
    subtype_explicit: bool | None = None
    #: "" | mixed | broken | fused | uncertain.
    exception: str = ""
    allocations: list[AllocationIn] = Field(default_factory=list)


class WordEditIn(Schema):
    word_id: int | None = None
    #: The word's RIGHT edge, and the larger number — Arabic runs right to left.
    start_x: int = Field(ge=0)
    end_x: int = Field(ge=0)
    #: The edges were dragged by hand; the next alignment keeps them.
    override: bool = False
    shared: bool = False


class LineEditIn(Schema):
    snapshot_id: str
    blobs: list[BlobEditIn]
    words: list[WordEditIn]


class DraftIn(Schema):
    """The page's editable lines, whole, as the editor holds them now.

    ``revision`` is the draft revision the edits were made on; an older one is
    refused rather than allowed to overwrite newer work. ``request_id`` makes a retry
    of this exact request land once.
    """

    revision: int = Field(ge=0)
    request_id: uuid.UUID
    lines: list[LineEditIn]
    #: Re-read the page under these edits before storing it — how a preview is
    #: accepted, so the stored draft is the previewed one, verdicts and flags too.
    realign: bool = False


class ConfirmIn(DraftIn):
    #: The reviewer has seen what still disagrees with the text and confirms anyway.
    acknowledge_exceptions: bool = False


class ProcessOut(Schema):
    job: JobOut


class SettingsIn(Schema):
    revision: int = Field(ge=0)
    experimental: bool
    acknowledge_unvalidated: bool = False
    #: The library's comparison; omitted keeps the current one.
    comparison: str | None = None
    #: The library's LIMIT; null is the comparison's default.
    limit: float | None = None


@router.put("/{mushaf_id}/calibration/settings")
def calibration_settings(request: HttpRequest, mushaf_id: uuid.UUID, data: SettingsIn) -> JsonResponse:
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    return _json(calibration_service.save_settings(mushaf, data.model_dump(), user=current_user(request)))


def _json(payload: dict, status: int = 200) -> JsonResponse:
    return JsonResponse(payload, status=status, json_dumps_params={"ensure_ascii": False})


@router.get("/{mushaf_id}/calibration/pages")
def calibration_pages(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Which pages have a calibration review, processed or confirmed — for the rail."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return {"pages": calibration_service.page_states(mushaf)}


@router.get("/{mushaf_id}/calibration/job", response=JobStatusOut)
def calibration_job(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """The mushaf's current or latest calibration processing — one page or a batch.
    The polling endpoint; ``kind`` says which."""
    mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    job = jobs_service.latest_for(mushaf_id, kind=CALIBRATION_JOBS)
    return {"job": jobs_service.to_dict(job) if job else None}


@router.post("/{mushaf_id}/calibration/cancel", response=JobOut)
def cancel_calibration(request: HttpRequest, mushaf_id: uuid.UUID) -> dict:
    """Stop the page or the batch being processed. A batch stops between pages, and
    every page it finished stays processed."""
    mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    job = jobs_service.request_cancel(mushaf_id, kind=CALIBRATION_JOBS, message="calibration_no_active_job")
    return jobs_service.to_dict(job)


class BatchIn(Schema):
    """A range of pages to process for calibration review, one after another."""

    first: int = Field(ge=1)
    last: int = Field(ge=1)
    #: Also process again the drafts nobody has touched, so they read with the
    #: learning as it is now. Drafts somebody worked on are never processed over.
    refresh: bool = False
    #: Say what the batch would do, page by page, and start nothing.
    dry_run: bool = False


@router.post("/{mushaf_id}/calibration/batch", response={200: dict, 202: ProcessOut})
def calibration_batch(request: HttpRequest, mushaf_id: uuid.UUID, data: BatchIn) -> tuple[int, dict]:
    """Process pages ``first``..``last`` for review as one background job.

    With ``dry_run``, the plan instead: each page's fate and why — see
    ``api.services.calibration_batch`` — and what a page has taken to process here.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    if data.dry_run:
        return 200, batch_service.plan(mushaf, data.first, data.last, refresh=data.refresh)
    job = batch_service.start(mushaf, data.first, data.last, refresh=data.refresh, user=current_user(request))
    return 202, {"job": jobs_service.to_dict(job)}


@router.get("/{mushaf_id}/calibration/readiness")
def calibration_readiness(request: HttpRequest, mushaf_id: uuid.UUID) -> JsonResponse:
    """The readiness meter: whether calibration has learned enough that processing the
    rest in bulk loses little. An estimate from the confirmed pages, never a verdict."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(progress_service.readiness(mushaf))


@router.get("/{mushaf_id}/calibration/evaluation")
def calibration_evaluation(request: HttpRequest, mushaf_id: uuid.UUID) -> JsonResponse:
    """Frozen, full-line and calibrated results against every confirmed page.

    Read-only, and switches nothing on: automatic locks stay off until a person has
    read this and approved it.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(calibration_service.evaluation(mushaf))


@router.get("/{mushaf_id}/pages/{page_number}/calibration/evaluation")
def calibration_evaluation_page(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> JsonResponse:
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(calibration_service.evaluation_page(mushaf, page_number))


@router.get("/{mushaf_id}/pages/{page_number}/calibration")
def page_calibration(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> JsonResponse:
    """The page's calibration draft — empty if the page has never been processed."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(calibration_service.page_document(mushaf, page_number))


@router.post("/{mushaf_id}/pages/{page_number}/calibration/process", response={202: ProcessOut})
def process_calibration(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int) -> tuple[int, dict]:
    """Process one page for review; returns at once with the job to poll."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    job = calibration_service.start_page(mushaf, page_number, user=current_user(request))
    return 202, {"job": jobs_service.to_dict(job)}


@router.put("/{mushaf_id}/pages/{page_number}/calibration")
def save_calibration(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: DraftIn) -> JsonResponse:
    """Save the draft. Never a source of examples — only a confirmation is."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    return _json(
        calibration_service.save(mushaf, page_number, data.model_dump(mode="json"), user=current_user(request))
    )


@router.post("/{mushaf_id}/pages/{page_number}/calibration/preview")
def preview_calibration(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: DraftIn) -> JsonResponse:
    """These edits re-aligned, for the reviewer to accept or discard. Stores nothing."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(calibration_service.preview(mushaf, page_number, data.model_dump(mode="json")))


@router.post("/{mushaf_id}/pages/{page_number}/calibration/confirm")
def confirm_calibration(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: ConfirmIn) -> JsonResponse:
    """Approve the whole page: its words become the product, its blobs examples."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))
    return _json(
        calibration_service.save(
            mushaf, page_number, data.model_dump(mode="json"), confirm=True, user=current_user(request)
        )
    )


@router.post("/{mushaf_id}/pages/{page_number}/calibration/types")
def calibration_types(request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: DraftIn) -> JsonResponse:
    """A type for every untyped mark, and a doubt on every typed one the other pages
    disagree with — learned from typed marks. Stores nothing."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(calibration_service.type_suggestions(mushaf, page_number, data.model_dump(mode="json")))


class TypeEvidenceIn(DraftIn):
    """The draft as the editor holds it, and the one mark to explain."""

    snapshot_id: str
    blob_id: int


@router.post("/{mushaf_id}/pages/{page_number}/calibration/types/evidence")
def calibration_type_evidence(
    request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, data: TypeEvidenceIn
) -> JsonResponse:
    """The typed examples nearest one mark, type by type — why it is expected to be
    what it is. Stores nothing."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return _json(calibration_service.type_evidence(mushaf, page_number, data.model_dump(mode="json")))


@router.get("/{mushaf_id}/pages/{page_number}/calibration/examples")
def calibration_examples(
    request: HttpRequest, mushaf_id: uuid.UUID, page_number: int, snapshot: uuid.UUID, blob: int
) -> dict:
    """The confirmed examples nearest one blob — what the inspector shows."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request), write=False)
    return calibration_service.examples(mushaf, page_number, str(snapshot), blob)

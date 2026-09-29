"""Calibration review, one page at a time: process, correct, confirm, learn.

The loop the reviewer works in::

    process page N ─► review its blobs and words ─► preview ─► confirm
          ▲                                                       │
          └──────── examples from every confirmed page < N ◄──────┘

**What is decided where.** Every blob of a line is a *body* (part of a letter) or a
*mark* (anything else). The engine decides that for itself — ``ink.body_score``
prices each reading and the alignment picks the cheapest — unless someone has
already decided it:

* **the reviewer** — a role they set, or a blob they gave to a word, is a hard
  constraint the alignment cannot break (``core.word_boundary.inputs.BlobConstraint``);
* **calibration** — a blob whose nearest confirmed examples agree closely and
  unanimously. For now in **shadow**: the proposal is recorded and shown beside the
  engine's own reading, never applied. Applying them waits for an evaluation the
  reviewer has read and approved — see :func:`evaluation`.

Everything else keeps the frozen engine's scoring.

**What is stored.** The page's working *draft* lives on ``CalibrationReview.payload``
and changes with every save. Only three moments are written as immutable
``CalibrationRevision`` rows: what the engine proposed when the page was processed
(the prediction record the evaluation compares against), each confirmation (the only
source of examples), and archived hand-corrected boundaries. Nearest examples are
not stored at all — the inspector asks for one blob's when it is selected.

**The document.** One JSON shape travels between here and the editor::

    page, start, end          the page and the aya span read to cover it
    stream                    that span's words, in order
    lines                     this page's text lines — editable
    context                   neighbouring pages' lines of the same ayat — read-only
    issues                    what the last alignment found worth saying

and every line carries ``blobs`` (geometry, evidence, role, who decided it,
allocations to words, attention flags) and ``words`` (edges, and whether an edge
was set by hand). All x and y are **page** pixels.
"""

from __future__ import annotations

import copy
import logging
import uuid
from collections import OrderedDict
from dataclasses import asdict
from typing import Any, NoReturn, cast

from django.db import transaction
from ninja.errors import HttpError

from accounts.models import User
from api import i18n
from api.models import (
    ActivityTypeChoices,
    CalibrationProfile,
    CalibrationReview,
    CalibrationRevision,
    CalibrationRevisionKind,
    CalibrationSettings,
    CalibrationSnapshot,
    Line,
    LineTypeChoices,
    Mushaf,
    Page,
    ProcessJob,
    ProcessJobKindChoices,
    ProcessJobStateChoices,
    Segment,
)
from api.services import activity, jobs, line_images, word_coordinates, word_inputs, word_runs
from api.services import calibration_snapshots as snapshots
from core.word_boundary import IjamMode, WordBoundaryInput, WordInput, detect_words
from core.word_boundary.engine import detect_prepared
from core.word_boundary.examples import (
    DEFAULT_CONFIG,
    FEATURE_VERSION,
    PreparedIndex,
    build_prepared,
    build_type_index,
    nearest_by_type,
    predict_prepared,
    predict_types,
)
from core.word_boundary.ink import attach_marks
from core.word_boundary.results import InkComponent, WordLine
from quran.models import CountingSystem
from quran.services import words as words_service

logger = logging.getLogger(__name__)

Doc = dict[str, Any]

TEXT_ROLES = ("body", "mark")
EXCEPTIONS = ("", "mixed", "broken", "fused", "uncertain")
#: The contested band of ``body_score``: measured bimodal with an empty gap at 7-9
#: (see ``core.word_boundary.calibration``), so a blob in here is the evidence's own
#: admission that it cannot say.
UNCERTAIN_SCORES = range(6, 10)
#: How far an edge may move before the evaluation counts it as corrected, in page px.
EDGE_TOLERANCE = 3
#: A blob stands for at most this many PAWs. Generous; it only catches nonsense.
MAX_PAWS = 8
#: The matcher's settings. Recorded in every profile, so a change of settings is a
#: change of profile and an old evaluation stays reproducible.
MATCHER_CONFIG = dict(DEFAULT_CONFIG)


def settings_document(mushaf: Mushaf) -> Doc:
    setting = CalibrationSettings.objects.filter(mushaf=mushaf).first()
    return {"revision": setting.revision if setting else 0, "experimental": bool(setting and setting.experimental)}


@transaction.atomic
def save_settings(mushaf: Mushaf, data: Doc, *, user: User | None) -> Doc:
    Mushaf.objects.select_for_update().get(pk=mushaf.pk)
    setting, _ = CalibrationSettings.objects.get_or_create(mushaf=mushaf)
    if setting.revision != data["revision"]:
        _refuse("stale_revision")
    if data["experimental"] and not data.get("acknowledge_unvalidated"):
        _refuse("invalid_edits", 422)
    setting.experimental = data["experimental"]
    setting.revision += 1
    setting.save(update_fields=["experimental", "revision", "updated_at"])
    activity.emit(
        mushaf, ActivityTypeChoices.CALIBRATION_SAVED, {"action": "settings", **settings_document(mushaf)}, actor=user
    )
    return settings_document(mushaf)


def _refuse(key: str, status: int = 409, **kwargs: object) -> NoReturn:
    raise HttpError(status, i18n.t(f"calibration_{key}", **kwargs))


def _review(mushaf: Mushaf, page: int) -> CalibrationReview | None:
    return CalibrationReview.objects.filter(mushaf=mushaf, page_number=page).first()


def _system(mushaf: Mushaf) -> CountingSystem | None:
    try:
        return word_inputs.counting_system_for(mushaf)
    except LookupError:
        return None


# ---------------------------------------------------------------------------
# Examples: what the matcher is built from
# ---------------------------------------------------------------------------
def _approval(review: CalibrationReview) -> CalibrationRevision | None:
    """The immutable revision a review's confirmation points at, if it has one."""
    if review.confirmed_revision is None:
        return None
    return CalibrationRevision.objects.filter(
        review=review, number=review.confirmed_revision, kind=CalibrationRevisionKind.CONFIRMED
    ).first()


def _approved(mushaf: Mushaf, before_page: int) -> list[CalibrationRevision]:
    """Every confirmed approval of a page before ``before_page``, in page order.

    *Before*, strictly: a page is never predicted from its own labels, which is
    what makes the prediction record of each page an honest test of the pages
    before it.
    """
    reviews = CalibrationReview.objects.filter(
        mushaf=mushaf, page_number__lt=before_page, confirmed_revision__isnull=False
    ).order_by("page_number")
    return [revision for revision in (_approval(review) for review in reviews) if revision is not None]


def _approvals(mushaf: Mushaf) -> list[tuple[int, CalibrationRevision]]:
    """Every page's confirmed approval, with its page number, in page order."""
    reviews = CalibrationReview.objects.filter(mushaf=mushaf, confirmed_revision__isnull=False).order_by("page_number")
    return [(review.page_number, revision) for review in reviews if (revision := _approval(review)) is not None]


def _eligible(blob: Doc) -> bool:
    """Whether a confirmed blob may teach the matcher body-versus-mark.

    Not ornaments or symbols — they are structure, not text. Not anything flagged
    as an exception. And not a body standing for other than exactly one PAW: a
    broken fragment (0) or fused pair (2) is letter ink whose *count* is unusual,
    and teaching its shape as an ordinary body would teach the wrong thing.
    """
    if blob["role"] not in TEXT_ROLES or blob.get("exception"):
        return False
    if blob["role"] == "body" and blob.get("allocations"):
        return bool(sum(allocation["paws"] for allocation in blob["allocations"]) == 1)
    return True


def _samples(mushaf: Mushaf, revisions: list[CalibrationRevision]) -> list[dict]:
    ids = {line["snapshot_id"] for revision in revisions for line in revision.payload.get("lines", [])}
    stored = {str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=ids)}
    samples = []
    for revision in revisions:
        for line in revision.payload.get("lines", []):
            snapshot = stored.get(line["snapshot_id"])
            if snapshot is None:
                continue
            features = snapshots.blob_features(snapshot)
            for blob in line["blobs"]:
                if not _eligible(blob) or blob["id"] not in features:
                    continue
                samples.append(
                    {
                        "sample_id": f"{revision.pk}:{snapshot.pk}:{blob['id']}",
                        "snapshot_id": str(snapshot.pk),
                        "blob_id": blob["id"],
                        "page_number": snapshot.page_number,
                        "line_number": snapshot.line_number,
                        "role": blob["role"],
                        "subtype": blob.get("subtype", "") if blob.get("subtype_explicit", True) else "",
                        "revision_id": str(revision.pk),
                        "features": features[blob["id"]],
                    }
                )
    return samples


#: Prepared indexes by mushaf and profile signature. A signature fixes the examples
#: exactly, so a cached index is never stale. The mushaf is part of the key because a
#: duplicate carries its original's profiles under the same signatures, but its own
#: snapshots. Bounded, because each index is a matrix of examples.
_PREPARED: OrderedDict[tuple[str, str], PreparedIndex] = OrderedDict()
_PREPARED_MAX = 2


def _prepared(mushaf: Mushaf, profile: CalibrationProfile) -> PreparedIndex:
    """A profile's index, built from exactly the approvals and settings it records.

    Never from whatever is approved now: a page re-confirmed since would otherwise
    change the examples behind a prediction that was made before it.
    """
    key = (str(mushaf.pk), profile.signature)
    prepared = _PREPARED.get(key)
    if prepared is not None:
        _PREPARED.move_to_end(key)
        return prepared
    revisions = sorted(
        CalibrationRevision.objects.filter(
            review__mushaf=mushaf, pk__in=profile.payload.get("revisions", [])
        ).select_related("review"),
        key=lambda revision: revision.review.page_number,
    )
    prepared = build_prepared(_samples(mushaf, revisions), profile.payload.get("config", MATCHER_CONFIG))
    _PREPARED[key] = prepared
    while len(_PREPARED) > _PREPARED_MAX:
        _PREPARED.popitem(last=False)
    return prepared


def profile_for(
    mushaf: Mushaf, before_page: int, *, experimental: bool | None = None
) -> tuple[CalibrationProfile, PreparedIndex]:
    """The profile predictions for ``before_page`` are made from, and its index.

    The profile row records only *which* approvals and *which* settings — the
    examples are rebuilt from those approvals' snapshots on demand. The same
    approvals and settings always hash to the same signature, and so the same row.
    """
    approved = _approved(mushaf, before_page)
    config = dict(MATCHER_CONFIG)
    # Experimental opt-in can start helping after the first confirmed page.
    # Keep distinct-descriptor support, closeness and opposite-class separation.
    if experimental is None:
        experimental = settings_document(mushaf)["experimental"]
    if experimental:
        config["min_distinct_pages"] = 1
    identity = {
        "feature_version": FEATURE_VERSION,
        "config": config,
        "revisions": [str(revision.pk) for revision in approved],
    }
    signature = snapshots.digest(identity)
    profile, _ = CalibrationProfile.objects.get_or_create(
        mushaf=mushaf,
        signature=signature,
        defaults={
            "payload": {**identity, "pages": [revision.review.page_number for revision in approved]},
            "mode": "shadow",
        },
    )
    return profile, _prepared(mushaf, profile)


def _profile_summary(profile: CalibrationProfile, prepared: PreparedIndex) -> Doc:
    return {
        "signature": profile.signature,
        "mode": profile.mode,
        "pages": profile.payload.get("pages", []),
        "examples": sum(len(refs) for refs in prepared.refs),
    }


# ---------------------------------------------------------------------------
# Reading a page
# ---------------------------------------------------------------------------
def _page_words(mushaf: Mushaf, page: int) -> Doc:
    row = Page.objects.filter(mushaf=mushaf, page_number=page).first()
    if row is None:
        return {"page": page, "lines": [], "issues": []}
    system = _system(mushaf)
    return {
        "page": page,
        "lines": word_coordinates.page_words(row, system),
        "issues": [asdict(issue) for issue in word_coordinates.coherence(row, system)],
    }


def _sources_current(mushaf: Mushaf, rows: list[Doc]) -> bool:
    """Whether every row's snapshot still describes the line it was taken from.

    False once the page is re-processed (new ``Line`` rows), a segment is moved in
    review, an erase stroke is drawn, or a measuring template is re-captured.
    """
    stored = {
        str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[r["snapshot_id"] for r in rows])
    }
    for row in rows:
        snapshot = stored.get(row["snapshot_id"])
        if snapshot is None:
            return False
        line = (
            Line.objects.filter(
                page__mushaf=mushaf, page__page_number=snapshot.page_number, line_number=snapshot.line_number
            )
            .select_related("page__mushaf")
            .first()
        )
        if line is None or str(line.pk) != row["line_id"]:
            return False
        if snapshots.source_fingerprint(line) != snapshot.fingerprint:
            return False
    return True


def _attach_urls(mushaf: Mushaf, document: Doc) -> None:
    rows = document.get("lines", []) + document.get("context", [])
    stored = {
        str(s.pk): s for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[r["snapshot_id"] for r in rows])
    }
    for row in rows:
        snapshot = stored.get(row["snapshot_id"])
        if snapshot is not None:
            row["image_url"] = snapshot.image.url
            row["labels_url"] = snapshot.labels.url


def _context_current(mushaf: Mushaf, rows: list[Doc]) -> bool:
    if not _sources_current(mushaf, rows):
        return False
    approved = _approved_rows(mushaf, {row["page_number"] for row in rows})
    return all(
        row.get("approval_fingerprint") == approved.get(row["snapshot_id"], {}).get("approval_fingerprint")
        for row in rows
    )


def page_document(mushaf: Mushaf, page: int) -> Doc:
    """The page's draft as the editor reads it — or an empty document if never processed."""
    review = _review(mushaf, page)
    document = copy.deepcopy(review.payload) if review else {}
    document.pop("request", None)
    document.update(
        page=page,
        revision=review.revision if review else 0,
        confirmed_revision=review.confirmed_revision if review else None,
    )
    for key in ("lines", "context", "issues", "legacy_lines", "stream"):
        document.setdefault(key, [])
    # Drafts stored before boxes held their marks show them held now; the next save
    # stores it. Nothing is written by reading.
    for row in document["lines"] + document["context"]:
        _fit_words(row)
    document.setdefault("profile", {"signature": "", "mode": "shadow", "pages": [], "examples": 0})
    document["processed"] = bool(document["lines"])
    document["settings"] = settings_document(mushaf)
    document["words"] = _page_words(mushaf, page)
    _attach_urls(mushaf, document)
    # Stale snapshots stay readable — the reviewer can see what they had — but no
    # longer accept edits: labels only mean something against the current pixels.
    document["stale"] = bool(document["lines"]) and not _sources_current(mushaf, document["lines"])
    # A neighbouring line changed: the page can still be edited, saved and confirmed,
    # but not read again until it is processed again — which keeps its decisions.
    document["context_stale"] = (
        bool(document["lines"]) and not document["stale"] and not _context_current(mushaf, document["context"])
    )
    return document


def page_states(mushaf: Mushaf) -> list[Doc]:
    """Every page that has a calibration review, and how far it has got."""
    return [
        {
            "page": review.page_number,
            "revision": review.revision,
            "confirmed_revision": review.confirmed_revision,
            "processed": bool(review.payload.get("lines")),
        }
        for review in CalibrationReview.objects.filter(mushaf=mushaf).order_by("page_number")
    ]


# ---------------------------------------------------------------------------
# Processing a page
# ---------------------------------------------------------------------------
def _span_for_page(mushaf: Mushaf, page: int) -> tuple[tuple[int, int], tuple[int, int]]:
    """The first and last aya printed on the page — the span that covers it.

    Those ayat may start on the page before and end on the page after; the lines
    there are read as context, never saved. A page whose segments are not all
    numbered cannot be addressed at all, and is refused rather than guessed.
    """
    row = Page.objects.filter(mushaf=mushaf, page_number=page).first()
    if row is None:
        _refuse("not_found", 404, page=page)
    if not row.reviewed:
        _refuse("not_reviewed", 422, page=page)
    rows = list(
        Segment.objects.filter(line__page=row, line__type=LineTypeChoices.TEXT)
        .order_by("line__line_number", "segment_order")
        .values_list("line__sura_id", "aya_number")
    )
    numbered = [(sura, aya) for sura, aya in rows if sura is not None and aya is not None]
    if not rows or len(numbered) != len(rows):
        _refuse("not_numbered", 422, page=page)
    return numbered[0], numbered[-1]


def _span_lines(mushaf: Mushaf, start: tuple[int, int], end: tuple[int, int]) -> list[Line]:
    first = line_images.locate(mushaf, *start).line
    last = line_images.locate(mushaf, *end, last=True).line
    candidates = (
        Line.objects.filter(
            page__mushaf=mushaf,
            type=LineTypeChoices.TEXT,
            page__page_number__gte=first.page.page_number,
            page__page_number__lte=last.page.page_number,
        )
        .select_related("page__mushaf")
        .prefetch_related("segments", "erase_strokes")
        .order_by("page__page_number", "line_number")
    )
    low, high = (first.page.page_number, first.line_number), (last.page.page_number, last.line_number)
    return [line for line in candidates if low <= (line.page.page_number, line.line_number) <= high]


def start_page(mushaf: Mushaf, page: int, *, user: User | None, inline: bool | None = None) -> ProcessJob:
    """Process one page for review, as a background job. Refuses what it can up front.

    A page already processed from the sources it still has is refused: there is
    nothing new to read. A page whose sources changed since — its own lines or the
    neighbouring ones its ayat cross onto: re-processed, re-reviewed, erased — may be
    processed again. Every decision on a line that did not change is kept (see
    :func:`_carry_decisions`), and the old revisions stay in the history.
    """
    start, end = _span_for_page(mushaf, page)
    plan = word_runs.preflight(mushaf, start, end)
    review = _review(mushaf, page)
    if (
        review is not None
        and review.payload.get("lines")
        and _sources_current(mushaf, review.payload["lines"])
        and _context_current(mushaf, review.payload.get("context", []))
    ):
        _refuse("already_processed", page=page)
    expected = review.revision if review else 0

    def run(job: ProcessJob) -> None:
        done = process_page(
            mushaf,
            page,
            expected_revision=expected,
            user=user,
            progress=lambda count: jobs._touch(job.id, phase="detecting", lines_done=count),
            cancelled=lambda: jobs.cancel_requested(job.id),
        )
        jobs.settle(
            job.id,
            ProcessJobStateChoices.COMPLETED if done else ProcessJobStateChoices.CANCELLED,
            pages_saved=1 if done else 0,
        )

    return jobs.start_words(
        mushaf,
        plan,
        user=user,
        runner=run,
        inline=inline,
        kind=ProcessJobKindChoices.CALIBRATION,
        current_page=page,
    )


def _text_role(raw: Doc) -> str:
    return "body" if raw["preferred"] == "body" else "mark"


def _blank_row(snapshot: CalibrationSnapshot, line: Line, prepared: PreparedIndex, *, readonly: bool) -> Doc:
    """A line as the engine first sees it: every blob with its evidence, nothing decided.

    Each text blob carries calibration's *proposal* — body, mark, or nothing when
    its nearest examples do not clear the gate. In shadow mode that is all it is.
    """
    data = snapshot.metadata
    ornaments = {ident for group in data["separators"] for ident in group}
    symbols = {ident for _, group in data["symbols"] for ident in group}
    features = snapshots.blob_features(snapshot) if prepared.roles and not readonly else {}
    ox, oy = data["bbox"]["x"] + data["offset_x"], data["bbox"]["y"] + data["offset_y"]
    blobs = []
    for raw in data["blobs"]:
        ident = raw["label"]
        role = "ornament" if ident in ornaments else "symbol" if ident in symbols else _text_role(raw)
        proposal: Doc = {}
        if role in TEXT_ROLES and ident in features:
            found = predict_prepared(features[ident], prepared)
            proposal = {
                "role": found["proposed_role"],
                "confidence": round(found["confidence"], 4),
                "reasons": found["reasons"],
            }
        blobs.append(
            {
                "id": ident,
                "x": raw["x"] + ox,
                "y": raw["y"] + oy,
                "w": raw["w"],
                "h": raw["h"],
                "area": raw["area"],
                "body_score": raw["body_score"],
                "role": role,
                "initial_role": role,
                "explicit": False,
                "ownership_explicit": False,
                "subtype": "",
                "subtype_explicit": False,
                "exception": "",
                "allocations": [],
                "attention": [],
                "decision_source": "search",
                "proposed_role": proposal.get("role"),
                "proposal": proposal,
            }
        )
    return {
        "snapshot_id": str(snapshot.pk),
        "line_id": str(line.pk),
        "page_number": snapshot.page_number,
        "line_number": snapshot.line_number,
        "bbox": data["bbox"],
        "band": [n + oy for n in data["band"]],
        "readonly": readonly,
        "approved": False,
        "status": None,
        "reason": None,
        "blobs": blobs,
        "words": [],
    }


def _approved_rows(mushaf: Mushaf, pages: set[int]) -> dict[str, Doc]:
    """Rows of *confirmed* neighbouring pages, by snapshot id — the approved context.

    Only confirmed ones: a neighbour's draft is somebody's work in progress, and
    treating it as settled would let one unfinished page constrain another.
    """
    found: dict[str, Doc] = {}
    for review in CalibrationReview.objects.filter(
        mushaf=mushaf, page_number__in=pages, confirmed_revision__isnull=False
    ):
        revision = _approval(review)
        if revision is None:
            continue
        for row in revision.payload.get("lines", []):
            # Content-based so unchanged approvals and gallery copies stay valid.
            fingerprint = snapshots.digest(
                {
                    "blobs": [{key: blob.get(key) for key in ("id", "role", "allocations")} for blob in row["blobs"]],
                    "words": row["words"],
                }
            )
            found[row["snapshot_id"]] = {**row, "approval_fingerprint": fingerprint}
    return found


def process_page(
    mushaf: Mushaf,
    page: int,
    *,
    expected_revision: int,
    user: User | None = None,
    progress: Any = None,
    cancelled: Any = None,
) -> bool:
    """Measure, predict and align one page, and store it as a fresh draft.

    Returns False when cancelled before storing anything. The engine's own reading
    at this moment — with calibration's proposals beside it, not applied — is also
    written as an immutable ``processed`` revision: the prediction record. It is what
    the evaluation compares the eventual confirmation against, so it is taken before
    anything a person did is put back on the page — decisions carried from an earlier
    draft, cuts corrected in the word editor — and never touched afterwards.
    """
    start, end = _span_for_page(mushaf, page)
    system = word_inputs.counting_system_for(mushaf)
    stream = words_service.word_stream(system, start=start, end=end)
    lines = _span_lines(mushaf, start, end)
    experimental = settings_document(mushaf)["experimental"]
    profile, prepared = profile_for(mushaf, page, experimental=experimental)
    templates = snapshots.Templates.of(mushaf)
    approved = _approved_rows(mushaf, {line.page.page_number for line in lines} - {page})
    earlier = _review(mushaf, page)
    before = {row["snapshot_id"]: row for row in (earlier.payload.get("lines", []) if earlier else [])}

    rendered: dict[Any, Any] = {}
    rows: list[Doc] = []
    for index, line in enumerate(lines, start=1):
        if cancelled is not None and cancelled():
            return False
        if line.page_id not in rendered:
            rendered[line.page_id] = line_images._render_page(mushaf, line.page)
        snapshot = snapshots.snapshot_line(mushaf, line, rendered[line.page_id], templates)
        readonly = line.page.page_number != page
        if readonly and str(snapshot.pk) in approved:
            row = _as_constraint(copy.deepcopy(approved[str(snapshot.pk)]))
        else:
            row = _blank_row(snapshot, line, prepared, readonly=readonly)
        rows.append(row)
        if progress is not None:
            progress(index)

    document: Doc = {
        "page": page,
        "start": list(start),
        "end": list(end),
        "stream": [asdict(word) for word in stream],
        "profile": _profile_summary(profile, prepared),
        "lines": [row for row in rows if not row["readonly"]],
        "context": [row for row in rows if row["readonly"]],
        "issues": [],
    }
    document = align_document(mushaf, document)
    prediction = _record(document, context=True)
    # Keep the canonical, unlocked prediction immutable for honest comparisons.
    # The setting is pinned to this run, not retroactively applied to older pages.
    if experimental:
        document["profile"]["mode"] = "experimental"
        document = align_document(mushaf, document, calibration_locks=True)

    # The draft: that reading, with what people already decided put back on it.
    decided, worded = _carry_decisions(document, before)
    if decided:
        document = align_document(mushaf, document, calibration_locks=document["profile"]["mode"] == "experimental")
    _keep_legacy_edges(document, _hand_made(mushaf, page), skip=worded)
    frozen = _frozen_record(mushaf, page, start, end, user)
    if cancelled is not None and cancelled():
        return False

    with transaction.atomic():
        review, _ = CalibrationReview.objects.select_for_update().get_or_create(mushaf=mushaf, page_number=page)
        if review.revision != expected_revision:
            _refuse("stale_revision")
        review.revision += 1
        document["legacy_lines"] = review.payload.get("legacy_lines", [])
        document["processed_revision"] = review.revision
        review.payload = document
        review.save(update_fields=["revision", "payload", "updated_at"])
        CalibrationRevision.objects.create(
            review=review,
            number=review.revision,
            kind=CalibrationRevisionKind.PROCESSED,
            payload={**prediction, "frozen": frozen},
        )
        activity.emit(
            mushaf,
            ActivityTypeChoices.CALIBRATION_PROCESSED,
            {"page_number": page, "revision": review.revision, "profile": profile.signature},
            actor=user,
        )
    return True


def _carry_decisions(document: Doc, before: dict[str, Doc]) -> tuple[bool, frozenset[str]]:
    """Put an earlier draft's decisions back on the lines that did not change.

    A line whose sources are unchanged keeps its snapshot, and so its blob ids: what
    the reviewer decided about blob 23 still means blob 23. A changed line has a new
    snapshot and starts over — its old labels described other pixels. Allocations
    and dragged words outside the new span are dropped with the span.

    Returns whether anything was carried, and the rows whose words were.
    """
    stream = {word["id"] for word in document["stream"]}
    carried = False
    worded: set[str] = set()
    for row in document["lines"]:
        old = before.get(row["snapshot_id"])
        if old is None:
            continue
        kept = {blob["id"]: blob for blob in old["blobs"]}
        for blob in row["blobs"]:
            earlier = kept.get(blob["id"])
            if earlier is None:
                continue
            blob.update(
                exception=earlier.get("exception", ""),
                subtype=earlier.get("subtype", ""),
                subtype_explicit=earlier.get("subtype_explicit", bool(earlier.get("subtype"))),
            )
            if earlier.get("explicit") and earlier["role"] in TEXT_ROLES and blob["initial_role"] in TEXT_ROLES:
                blob.update(role=earlier["role"], explicit=True, decision_source="human")
                carried = True
            allocations = [a for a in earlier.get("allocations") or [] if a["word_id"] in stream]
            if earlier.get("ownership_explicit") and (allocations or not earlier.get("allocations")):
                blob.update(ownership_explicit=True, allocations=allocations)
                carried = True
        dragged = [
            word
            for word in old["words"]
            if word.get("override") and (word["word_id"] is None or word["word_id"] in stream)
        ]
        if dragged:
            row["words"] = dragged
            worded.add(row["snapshot_id"])
            carried = True
    return carried, frozenset(worded)


def _as_constraint(row: Doc) -> Doc:
    """An approved neighbouring row, as fixed context for this page's alignment.

    The page was confirmed whole, so every role on it is a human decision and every
    allocation a human assignment — the alignment must read around them, not
    re-read them.
    """
    row["readonly"] = True
    row["approved"] = True
    for blob in row["blobs"]:
        if blob["role"] in TEXT_ROLES:
            blob["explicit"] = True
            blob["ownership_explicit"] = bool(blob["allocations"])
    return row


def _record(document: Doc, *, context: bool = False) -> Doc:
    """The part of a document an immutable revision keeps.

    An approval keeps only its own page: the context lines were never approved.
    The prediction record keeps them too, because re-reading the page later — the
    evaluation's calibrated result — needs the ayat's other lines to read it the
    same way it was read the first time.
    """
    dropped = ("request",) if context else ("context", "request")
    return {key: copy.deepcopy(value) for key, value in document.items() if key not in dropped}


def _cuts_of(line: Line) -> list[Doc]:
    """A line's stored cuts, in the order they are read."""
    return [
        {"word_id": row.word_id, "start_x": row.start_x, "end_x": row.end_x}
        for row in sorted(line.words.all(), key=lambda row: row.position)
    ]


def _overlay_cuts(row: Doc, cuts: list[Doc], references: dict[int, Doc]) -> None:
    """Put a line's hand-made cuts on its draft row, as edges no reading may move.

    Every cut becomes an override, which each later alignment keeps. The ink nobody
    has decided about yet is then given to the word whose cut it sits in, so each
    word's count reads against the boundaries as the hand drew them — not against
    the engine's own reading, which those boundaries replaced. Roles are left as
    they were read: a cut says where a word is, not what its ink is.
    """
    labelled: list[Doc] = []
    unlabelled: list[Doc] = []
    for cut in cuts:
        ident = cut["word_id"]
        if ident is not None and ident not in references:
            continue  # a word outside this span is not this draft's to hold
        reference = references.get(ident, {}) if ident is not None else {}
        (labelled if ident is not None else unlabelled).append(
            {
                "word_id": ident,
                "text": reference.get("text", ""),
                "aya": reference.get("aya", ""),
                "expected_paws": reference.get("paws", 0),
                "start_x": int(cut["start_x"]),
                "end_x": int(cut["end_x"]),
                "override": True,
                "shared": False,
            }
        )
    if not labelled and not unlabelled:
        return
    row["words"] = _in_reading_order(labelled, unlabelled)
    for blob in row["blobs"]:
        if blob["role"] not in TEXT_ROLES or blob.get("ownership_explicit"):
            continue
        center = blob["x"] + blob["w"] / 2
        owner = next((word["word_id"] for word in labelled if word["end_x"] <= center < word["start_x"]), None)
        blob["allocations"] = (
            [{"word_id": owner, "paws": 1 if blob["role"] == "body" else 0}] if owner is not None else []
        )
    # Cuts made while boxes held bodies only leave the marks they were given outside.
    _fit_words(row)


def _hand_made(mushaf: Mushaf, page: int) -> dict[str, list[Doc]]:
    """This page's hand-made lines' cuts, by line id — as the draft rows name them."""
    lines = (
        Line.objects.filter(word_coordinates.HAND_MADE, page__mushaf=mushaf, page__page_number=page)
        .distinct()
        .prefetch_related("words")
    )
    return {str(line.pk): _cuts_of(line) for line in lines}


def _keep_legacy_edges(document: Doc, hand_made: dict[str, list[Doc]], *, skip: frozenset[str] = frozenset()) -> None:
    """Words a person corrected in the word editor keep their corrected edges.

    ``skip`` names rows whose words already came from this page's previous draft:
    those edges are the calibration reviewer's own, and no older than the cuts.
    """
    references = {word["id"]: word for word in document["stream"]}
    for row in document["lines"]:
        cuts = hand_made.get(row["line_id"])
        if cuts is not None and row["snapshot_id"] not in skip:
            _overlay_cuts(row, cuts, references)


def absorb_legacy_edits(payload: Doc, lines: list[Line]) -> None:
    """Bring cuts corrected in the word editor into this page's open draft.

    Whichever editor touched a line last is what the draft shows. Without this, a
    line corrected in the word editor after the page was processed here would be
    overwritten by the page's next confirmation, which writes every line's words.
    Called by ``word_coordinates.preserve_legacy_edits`` inside its transaction.
    """
    rows = {row["line_id"]: row for row in payload.get("lines", [])}
    references = {word["id"]: word for word in payload.get("stream", [])}
    for line in lines:
        row = rows.get(str(line.pk))
        if row is not None:
            _overlay_cuts(row, _cuts_of(line), references)


def _frozen_record(mushaf: Mushaf, page: int, start: tuple[int, int], end: tuple[int, int], user: User | None) -> Doc:
    """What the frozen engine, on its own cropped-line path, makes of the same span.

    The first of the three results the evaluation lays side by side — frozen,
    full-line without locks, full-line with locks — kept in page coordinates so it
    compares with the other two directly. Only this page's lines are kept.
    """
    try:
        legacy = word_inputs.prepare_engine_input(mushaf.id, user=user, start=start, end=end)
        result = detect_words(legacy.source)
    except Exception:  # an evaluation aid must never cost the reviewer their page
        logger.exception("Frozen-engine record failed for page %s", page)
        return {"lines": [], "error": True}
    lines = []
    for outcome, placed in zip(result.lines, legacy.placements, strict=True):
        if placed.line.page.page_number != page:
            continue
        lines.append(
            {
                "page_number": page,
                "line_number": placed.line.line_number,
                "status": outcome.status,
                "reason": outcome.reason,
                "words": [
                    {
                        "word_id": box.word_id,
                        "start_x": box.right + placed.origin_x,
                        "end_x": box.end_x + placed.origin_x,
                    }
                    for box in outcome.words
                ],
            }
        )
    return {"lines": lines}


# ---------------------------------------------------------------------------
# Aligning a document
# ---------------------------------------------------------------------------
def align_document(
    mushaf: Mushaf, document: Doc, *, calibration_locks: bool = False, affected_ayas: set[str] | None = None
) -> Doc:
    """Re-read the document's span under every decision already made on it.

    Human roles and assignments are hard constraints. With ``calibration_locks``,
    calibration's proposals are applied as *provisional* locks — released aya by aya
    by the engine if they make an aya unreadable — which is the third result the
    evaluation compares; the editor never asks for it while calibration is in shadow.

    Words printed touching across a word break are read as one — see
    :func:`_fused_units`.

    ``affected_ayas`` scopes a preview to what the reviewer edited: the page is
    read whole — the search needs its neighbours — but the new reading is taken
    only for those ayat, and for any aya whose ink it passes to or from them
    (:func:`_changed_ayas`). Everything else keeps the draft's state.

    Returns a new document; the one passed in is not modified.
    """
    result = copy.deepcopy(document)
    if affected_ayas == set():
        return result
    rows = sorted(result["lines"] + result["context"], key=lambda row: (row["page_number"], row["line_number"]))
    stored = {
        str(s.pk): s
        for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[row["snapshot_id"] for row in rows])
    }
    start = (int(result["start"][0]), int(result["start"][1]))
    end = (int(result["end"][0]), int(result["end"][1]))
    units = _fused_units(rows, result["stream"])
    unit_of = {member: head for head, members in units.items() for member in members}

    images, inks, cut_by_row = [], [], []
    for row in rows:
        image, ink = snapshots.load(stored[row["snapshot_id"]])
        cut = set(snapshots.select_span(ink, stored[row["snapshot_id"]].metadata, start, end))
        decided = {blob["id"]: blob for blob in row["blobs"]}
        for blob in ink.components:
            edited = decided.get(blob.label)
            if edited is None:
                continue
            _constrain(blob, edited, unit_of, calibration_locks=calibration_locks)
        images.append(image)
        inks.append(ink)
        cut_by_row.append(cut)

    original = {word["id"]: word for word in result["stream"]}
    stream = []
    for word in result["stream"]:
        head = unit_of.get(word["id"])
        if head is None:
            stream.append(_word(word))
        elif head == word["id"]:
            stream.append(_unit([original[member] for member in units[head]]))
    source = WordBoundaryInput(lines=images, words=stream, ijam=cast(IjamMode, mushaf.ijam_mode))
    aligned = detect_prepared(source, inks)

    overrides = {
        word["word_id"]: row["snapshot_id"]
        for row in rows
        for word in row["words"]
        if word["word_id"] is not None and word.get("override")
    }
    # Where the reading put each word, over every line at once: a word it moved to
    # another line is not missing from the one it left.
    placed = {
        member
        for outcome in aligned.lines
        for box in outcome.words
        if box.word_id is not None
        for member in units.get(box.word_id, [box.word_id])
    }
    readings: list[tuple[Doc, Doc, WordLine]] = []
    for row, outcome, ink, cut in zip(rows, aligned.lines, inks, cut_by_row, strict=True):
        if row.get("approved"):
            continue
        fresh = copy.deepcopy(row)
        _apply_outcome(fresh, outcome, ink, cut, original, overrides, units, placed)
        readings.append((row, fresh, outcome))

    scope = None if affected_ayas is None else _changed_ayas(readings, affected_ayas, original)
    issues: list[str] = []
    for row, fresh, outcome in readings:
        taken = fresh if scope is None else _within(row, fresh, scope, original)
        if taken is row:
            continue
        row.clear()
        row.update(taken)
        if outcome.status != "exact" and not row["readonly"]:
            issues.append(outcome.reason or outcome.status)
    result["issues"] = sorted(set(issues))
    return result


def _owner_ayas(blob: Doc, original: dict[int, Doc]) -> set[str]:
    return {original[a["word_id"]]["aya"] for a in blob.get("allocations") or [] if a["word_id"] in original}


def _changed_ayas(readings: list[tuple[Doc, Doc, WordLine]], edited: set[str], original: dict[int, Doc]) -> set[str]:
    """The ayat an edit actually changes: the ones it names, and — transitively —
    any aya the new reading passes ink to or from one of them.

    Ink changing hands links the ayat on both sides: a word of an edited aya that
    now takes a blob away from a neighbouring aya's word has changed that word too,
    and taking the new reading for one side only would leave the blob counted by
    both, or by neither. Ink moving between two ayat nobody edited links nothing.
    """
    links: list[set[str]] = []
    for before, after, _ in readings:
        old = {blob["id"]: blob for blob in before["blobs"]}
        for blob in after["blobs"]:
            was, now = _owner_ayas(old[blob["id"]], original), _owner_ayas(blob, original)
            if was != now:
                links.append(was | now)
    scope = set(edited)
    grown = True
    while grown:
        grown = False
        for group in links:
            if group & scope and not group <= scope:
                scope |= group
                grown = True
    return scope


def _takes_new(before: Doc, after: Doc, rows: tuple[Doc, Doc], scope: set[str], original: dict[int, Doc]) -> bool:
    """Whether one blob takes the new reading: when an aya in scope owns it, before
    or after. Ink nobody owns either way belongs with the words around it."""
    owners = _owner_ayas(before, original) | _owner_ayas(after, original)
    if owners:
        return bool(owners & scope)
    return bool((_blob_ayas(before, rows[0], original) | _blob_ayas(after, rows[1], original)) & scope)


def _within(before: Doc, after: Doc, scope: set[str], original: dict[int, Doc]) -> Doc:
    """One line with the new reading taken for the ayat in scope, and kept for the rest.

    A line takes part if it held a word of those ayat before, holds one now — a word
    the reading moved onto this line must land here — or has ink they own. Returns
    ``before`` itself when the line takes no part.
    """
    old = {blob["id"]: blob for blob in before["blobs"]}
    fresh = [_takes_new(old[blob["id"]], blob, (before, after), scope, original) for blob in after["blobs"]]
    labelled = [word for word in before["words"] + after["words"] if word["word_id"] is not None]
    if not any(fresh) and not any(word["aya"] in scope for word in labelled):
        return before
    merged = copy.deepcopy(after)
    # Unrelated ayat keep exactly what the draft had.
    merged["blobs"] = [blob if new else old[blob["id"]] for blob, new in zip(after["blobs"], fresh, strict=True)]
    merged["words"] = _in_reading_order(
        [word for word in after["words"] if word["word_id"] is not None and word["aya"] in scope]
        + [word for word in before["words"] if word["word_id"] is not None and word["aya"] not in scope],
        [word for word in before["words"] if word["word_id"] is None],
    )
    return merged


def _word(raw: Doc) -> WordInput:
    return WordInput(
        text=raw["text"],
        paws=raw["paws"],
        ijam_above=raw["ijam_above"],
        ijam_below=raw["ijam_below"],
        aya=raw["aya"],
        id=raw["id"],
    )


def _fused_units(rows: list[Doc], stream: list[Doc]) -> dict[int, list[int]]:
    """Words printed touching across a word break, as the engine has to see them.

    A body the reviewer gave to two words is one blob holding the end of one word
    and the start of the next. The engine puts each blob in one word, and every word
    needs a body of its own — so a word whose whole ink is that shared blob (في, لا,
    any one-PAW word) could never be placed. The words a shared blob joins are read
    as a single *unit* instead, their PAWs and dots added up, and split again at the
    shared blob afterwards (:func:`_apply_outcome`). Chains join: blobs shared by
    words 4-5 and by 5-6 make one unit of 4, 5 and 6.

    Only runs of consecutive words in one aya — the only ones ink can join — are
    kept; ``_merge_blob`` refuses anything else before it gets here.

    Returns each unit's first word id → its word ids, in reading order.
    """
    position = {word["id"]: index for index, word in enumerate(stream)}
    aya = {word["id"]: word["aya"] for word in stream}
    parent: dict[int, int] = {}

    def root(ident: int) -> int:
        while parent.setdefault(ident, ident) != ident:
            parent[ident] = parent[parent[ident]]
            ident = parent[ident]
        return ident

    for row in rows:
        for blob in row["blobs"]:
            ids = [allocation["word_id"] for allocation in blob.get("allocations") or []]
            if not (blob.get("ownership_explicit") and blob["role"] == "body" and len(ids) > 1):
                continue
            if any(ident not in position for ident in ids):
                continue
            for other in ids[1:]:
                parent[root(other)] = root(ids[0])

    grouped: dict[int, list[int]] = {}
    for ident in list(parent):
        grouped.setdefault(root(ident), []).append(ident)
    units = {}
    for members in grouped.values():
        members.sort(key=position.__getitem__)
        places = [position[member] for member in members]
        consecutive = places == list(range(places[0], places[0] + len(places)))
        if len(members) > 1 and consecutive and len({aya[member] for member in members}) == 1:
            units[members[0]] = members
    return units


def _unit(members: list[Doc]) -> WordInput:
    """Consecutive words the engine is to read as one: everything they predict, added."""
    return WordInput(
        text=" ".join(member["text"] for member in members),
        paws=sum(member["paws"] for member in members),
        ijam_above=sum(member["ijam_above"] for member in members),
        ijam_below=sum(member["ijam_below"] for member in members),
        aya=members[0]["aya"],
        id=members[0]["id"],
    )


def _constrain(blob: Any, edited: Doc, unit_of: dict[int, int], *, calibration_locks: bool) -> None:
    """Carry one blob's decisions onto the engine's ``Blob``.

    A body given to words is placed in them and counts exactly the PAWs it was given
    — all of them together when it is shared by two words, since those two are one
    unit to the engine (see :func:`_fused_units`).
    """
    if (edited["explicit"] or edited.get("ownership_explicit")) and edited["role"] in TEXT_ROLES:
        blob.locked_role = edited["role"]
        blob.lock_source = "human"
    elif calibration_locks and edited.get("proposed_role") in TEXT_ROLES:
        blob.locked_role = edited["proposed_role"]
        blob.lock_source = "calibration"
    allocations = edited.get("allocations") or []
    if not (edited.get("ownership_explicit") and edited["role"] == "body" and allocations):
        return
    first = min(allocation["word_id"] for allocation in allocations)
    blob.assigned_word_id = unit_of.get(first, first)
    blob.paw_count = sum(allocation["paws"] for allocation in allocations)
    blob.locked_role = "body"
    blob.lock_source = "human"


def _split_unit(components: list[int], members: list[int], blobs: dict[int, Doc]) -> dict[int, int]:
    """Give each blob of a fused unit to the member word it belongs to.

    Read right to left, a unit's blobs are its first word's up to the blob it shares
    with the second, then the second's up to the next shared blob, and so on. The
    shared blobs themselves are left out: their allocations are the reviewer's.
    """
    owners: dict[int, int] = {}
    at = 0
    placed = [label for label in components if label in blobs]
    for label in sorted(placed, key=lambda label: -(blobs[label]["x"] + blobs[label]["w"])):
        blob = blobs[label]
        shared = {allocation["word_id"] for allocation in blob.get("allocations") or []}
        if blob.get("ownership_explicit") and len(shared) > 1:
            at = max([at, *(index for index, member in enumerate(members) if member in shared)])
            continue
        owners[label] = members[at]
    return owners


def _edges_from_ink(row: Doc, word_id: int) -> tuple[int, int] | None:
    """A word's right and left edge, from its assigned bodies and marks.

    Where a body is shared with the word before — to the right — the word starts
    inside it, at its middle; shared with the word after, it ends there. The middle
    is only a first guess at a cut that lies somewhere inside one blob of ink, and
    the reviewer's to drag.
    """
    start: int | None = None
    end: int | None = None
    for blob in row["blobs"]:
        ids = [allocation["word_id"] for allocation in blob.get("allocations") or []]
        if blob["role"] not in TEXT_ROLES or word_id not in ids:
            continue
        # Whole pixels, the same arithmetic as the editor's ``edgesFromInk``.
        middle = blob["x"] + blob["w"] // 2
        right = middle if any(ident < word_id for ident in ids) else blob["x"] + blob["w"]
        left = middle if any(ident > word_id for ident in ids) else blob["x"]
        start = right if start is None else max(start, right)
        end = left if end is None else min(end, left)
    if start is None or end is None or start <= end:
        return None
    return start, end


def _own_extent(row: Doc, word_id: int) -> tuple[int, int] | None:
    """The right and left edge of the ink this word owns alone: its bodies and marks
    that no other word shares."""
    right: int | None = None
    left: int | None = None
    for blob in row["blobs"]:
        owners = {allocation["word_id"] for allocation in blob.get("allocations") or []}
        if blob["role"] not in TEXT_ROLES or owners != {word_id}:
            continue
        right = blob["x"] + blob["w"] if right is None else max(right, blob["x"] + blob["w"])
        left = blob["x"] if left is None else min(left, blob["x"])
    return None if right is None or left is None else (right, left)


def _fit_words(row: Doc) -> None:
    """Widen every word's box to hold all the ink it owns alone. In place.

    A word's box spans its bodies *and* its marks (the user's rule, 2026-09-27). A box
    set by hand -- dragged in the editor, or a cut carried in from the word editor --
    keeps where the hand put it, except that it may never leave the word's own ink
    outside: a hand widens a box, or moves the cut inside a body two words share, and
    that shared body is the one piece of ink left out of the reckoning here. A box
    nobody set is its ink's extent already, and does not change. The editor's
    ``fitWord`` does the same arithmetic.
    """
    for word in row["words"]:
        if word["word_id"] is None:
            continue
        extent = _own_extent(row, word["word_id"])
        if extent is not None:
            word["start_x"] = max(word["start_x"], extent[0])
            word["end_x"] = min(word["end_x"], extent[1])


def _apply_outcome(
    row: Doc,
    outcome: WordLine,
    ink: Any,
    cut: set[int],
    original: dict[int, Doc],
    overrides: dict[int, str],
    units: dict[int, list[int]],
    placed: set[int],
) -> None:
    """Write one line's alignment back onto its document row.

    ``placed`` is every word the reading placed anywhere. A word of this row it
    placed nowhere is kept where it was, with its ink — a partial reading is a
    diagnostic, not an instruction to take a reviewer's words away. A word it placed
    on another line has moved, and goes.
    """
    if outcome.status == "unresolved" and row["words"]:
        # Failed alignment is a diagnostic, never a command to erase the draft.
        row.update(status=outcome.status, reason=outcome.reason)
        for blob in row["blobs"]:
            if blob["id"] in outcome.constraint_conflicts:
                blob["attention"] = sorted(set(blob["attention"]) | {"constraint-conflict"})
        return
    ox = row["bbox"]["x"]
    blobs = {blob["id"]: blob for blob in row["blobs"]}
    components: dict[int, InkComponent] = {component.id: component for component in outcome.components}
    owners: dict[int, int] = {}
    for box in outcome.words:
        if box.word_id is None:
            continue
        if box.word_id in units:
            owners.update(_split_unit(list(box.components), units[box.word_id], blobs))
            continue
        for label in box.components:
            owners[label] = box.word_id
    for body, marks in attach_marks(ink).items():
        if body in owners:
            for mark in marks:
                owners.setdefault(mark.label, owners[body])
    conflicts, released = set(outcome.constraint_conflicts), set(outcome.released_locks)
    locked = {blob.label: blob.lock_source for blob in ink.components if blob.locked_role is not None}
    missing_ids = {word["word_id"] for word in row["words"] if word["word_id"] is not None} - placed

    for blob in row["blobs"]:
        component = components.get(blob["id"])
        retained_missing = any(a["word_id"] in missing_ids for a in blob["allocations"])
        if component is not None and not blob["explicit"] and not retained_missing:
            blob["role"] = component.role
        if blob["role"] != "mark" and not blob.get("subtype_explicit"):
            blob["subtype"] = ""  # a body has no mark type; a person's own label stays
        if not blob.get("ownership_explicit"):
            owner = owners.get(blob["id"])
            paws = 1 if blob["role"] == "body" else 0
            if not retained_missing:
                blob["allocations"] = [{"word_id": owner, "paws": paws}] if owner is not None else []
        blob["decision_source"] = (
            "human"
            if blob["explicit"] or locked.get(blob["id"]) == "human"
            else "calibration"
            if locked.get(blob["id"]) == "calibration"
            else "search"
        )
        blob["attention"] = _attention(blob, component, cut, conflicts, released)

    previous = {word["word_id"]: word for word in row["words"] if word["word_id"] is not None}
    fresh_words: list[Doc] = []
    for box in outcome.words:
        if box.word_id is None:
            continue
        members = units.get(box.word_id)
        if members is None:
            edges = _edges_from_ink(row, box.word_id) or (box.right + ox, box.end_x + ox)
            fresh_words.append(
                {
                    "word_id": box.word_id,
                    "text": box.text,
                    "aya": box.aya,
                    "expected_paws": original.get(box.word_id, {}).get("paws", box.expected_paws),
                    "start_x": edges[0],
                    "end_x": edges[1],
                    "override": False,
                    "shared": False,
                }
            )
            continue
        # A unit comes back as one box: each of its words takes its edges from its
        # own ink, and the unit's box where it has none of its own.
        for member in members:
            edges = _edges_from_ink(row, member) or (box.right + ox, box.end_x + ox)
            fresh_words.append(
                {
                    "word_id": member,
                    "text": original[member]["text"],
                    "aya": original[member]["aya"],
                    "expected_paws": original[member]["paws"],
                    "start_x": edges[0],
                    "end_x": edges[1],
                    "override": False,
                    "shared": True,
                }
            )

    words: list[Doc] = []
    for fresh in fresh_words:
        set_on = overrides.get(fresh["word_id"])
        if set_on is not None and set_on != row["snapshot_id"]:
            continue  # its edges were set by hand on another line; that placement wins
        kept = previous.get(fresh["word_id"])
        if kept is not None and kept.get("override"):
            fresh.update(start_x=kept["start_x"], end_x=kept["end_x"], override=True)
        words.append(fresh)
    placed = {word["word_id"] for word in words}
    for word_id, kept in previous.items():
        # A hand-set word the engine did not place here stays where the hand put it.
        if word_id not in placed and (overrides.get(word_id) == row["snapshot_id"] or word_id in missing_ids):
            words.append(kept)
    if outcome.status == "unresolved" and row["words"] and not words:
        words = row["words"]  # never trade a reviewer's words for nothing
    unlabelled = [word for word in row["words"] if word["word_id"] is None]
    row["words"] = _in_reading_order(words, unlabelled)
    _fit_words(row)
    row["status"] = "partial" if missing_ids else outcome.status
    row["reason"] = "preview-kept-missing-words" if missing_ids else outcome.reason


def _in_reading_order(labelled: list[Doc], unlabelled: list[Doc]) -> list[Doc]:
    """Labelled words by their place in the text; unlabelled ones where they sit.

    The text's own order is the reading order. A word with no label has no place in
    the text, so it goes where its right edge puts it among the others — the same
    rule ``word_coordinates._place`` uses for a stored unlabelled cut.
    """
    ordered = sorted(labelled, key=lambda word: word["word_id"])
    for word in unlabelled:
        at = next((i for i, other in enumerate(ordered) if other["start_x"] < word["start_x"]), len(ordered))
        ordered.insert(at, word)
    return ordered


def _attention(
    blob: Doc, component: InkComponent | None, cut: set[int], conflicts: set[int], released: set[int]
) -> list[str]:
    """Why this blob deserves a look. Signals, never verdicts.

    Recomputed from scratch on every alignment, so a flag disappears once its cause
    has gone. An unflagged blob is not thereby correct — a wrong reading can have an
    exact count and a confident score — which is why confirmation is of the page.
    """
    flags = []
    if blob["role"] in TEXT_ROLES and not (blob["explicit"] or blob.get("ownership_explicit")):
        if blob["body_score"] in UNCERTAIN_SCORES:
            flags.append("uncertain")
        if not blob["explicit"] and blob["role"] != blob["initial_role"]:
            flags.append("search-override")
        if blob.get("proposed_role") and blob["proposed_role"] != blob["role"]:
            flags.append("calibration-disagreement")
        if component is not None and component.ambiguous:
            flags.append("ambiguous")
    if blob["id"] in cut:
        flags.append("span-boundary")
    if blob["id"] in conflicts:
        flags.append("constraint-conflict")
    if blob["id"] in released and not blob["explicit"]:
        flags.append("released-lock")
    return flags


# ---------------------------------------------------------------------------
# Edits, preview, save, confirm
# ---------------------------------------------------------------------------
def _blob_ayas(blob: Doc, row: Doc, references: dict[int, Doc]) -> set[str]:
    owned = {references[a["word_id"]]["aya"] for a in blob["allocations"] if a["word_id"] in references}
    if owned:
        return owned
    # Unattached ink can affect any word whose horizontal extent it intersects.
    nearby = {w["aya"] for w in row["words"] if w["end_x"] <= blob["x"] + blob["w"] and w["start_x"] >= blob["x"]}
    return nearby or {word["aya"] for word in row["words"]}


def _apply_edits(mushaf: Mushaf, review: CalibrationReview, data: Doc) -> Doc:
    """The draft with the client's edits applied — validated, never trusted.

    The client sends every editable line whole: every blob's decisions and every
    word's edges. Unknown blobs, words outside the span, a structural blob given a
    text role, marks carrying PAWs — all refused as one invalid edit.
    """
    if data["revision"] != review.revision:
        _refuse("stale_revision")
    document: Doc = copy.deepcopy(review.payload)
    if not _sources_current(mushaf, document.get("lines", [])):
        _refuse("stale_source")
    # As the editor was shown them (see ``page_document``): a box widened only to
    # hold its marks is not an edit, and must not send its aya to be read again.
    for row in document["lines"]:
        _fit_words(row)
    incoming = {line["snapshot_id"]: line for line in data["lines"]}
    if len(incoming) != len(data["lines"]) or set(incoming) != {row["snapshot_id"] for row in document["lines"]}:
        _refuse("invalid_edits", 422)
    references = {word["id"]: word for word in document["stream"]}
    pending = set(document.get("pending_ayas", []))
    used: set[int] = set()
    for row in document["lines"]:
        edit = incoming[row["snapshot_id"]]
        blobs = {blob["id"]: blob for blob in edit["blobs"]}
        if len(blobs) != len(edit["blobs"]) or set(blobs) != {blob["id"] for blob in row["blobs"]}:
            _refuse("invalid_edits", 422)
        for blob in row["blobs"]:
            before = copy.deepcopy(blob)
            _merge_blob(blob, blobs[blob["id"]], references)
            if any(
                before.get(key) != blob.get(key) for key in ("role", "explicit", "allocations", "ownership_explicit")
            ):
                pending.update(_blob_ayas(before, row, references) | _blob_ayas(blob, row, references))
        words = []
        for word in edit["words"]:
            ident = word["word_id"]
            if ident is not None and (ident not in references or ident in used):
                _refuse("invalid_edits", 422)
            if word["start_x"] <= word["end_x"]:
                _refuse("invalid_edits", 422)
            if ident is not None:
                used.add(ident)
            reference = references.get(ident, {})
            words.append(
                {
                    "word_id": ident,
                    "text": reference.get("text", ""),
                    "aya": reference.get("aya", ""),
                    "expected_paws": reference.get("paws", 0),
                    "start_x": int(word["start_x"]),
                    "end_x": int(word["end_x"]),
                    "override": bool(word.get("override")),
                    "shared": bool(word.get("shared")),
                }
            )
        _fit_words({"blobs": row["blobs"], "words": words})
        if row["words"] != words:
            old = {w["word_id"]: w for w in row["words"]}
            pending.update(w["aya"] for w in words if old.get(w["word_id"]) != w)
        row["words"] = words
    document["pending_ayas"] = sorted(pending)
    return document


def _merge_blob(blob: Doc, new: Doc, references: dict[int, Doc]) -> None:
    role = new["role"]
    structural = blob["initial_role"] in ("ornament", "symbol")
    if (structural and role != blob["initial_role"]) or (not structural and role not in TEXT_ROLES):
        _refuse("invalid_edits", 422)
    if new.get("exception", "") not in EXCEPTIONS:
        _refuse("invalid_edits", 422)
    allocations = new.get("allocations") or []
    word_ids = [allocation["word_id"] for allocation in allocations]
    if len(set(word_ids)) != len(word_ids) or any(word_id not in references for word_id in word_ids):
        _refuse("invalid_edits", 422)
    if len(word_ids) > 1 and not _joinable(word_ids, references, role):
        _refuse("invalid_edits", 422)
    for allocation in allocations:
        paws = allocation["paws"]
        if not isinstance(paws, int) or isinstance(paws, bool) or not 0 <= paws <= MAX_PAWS:
            _refuse("invalid_edits", 422)
        if role != "body" and paws:
            _refuse("invalid_edits", 422)
    # A decision is what the client says is one. A role that merely differs from the
    # stored one is not: undoing an accepted preview sends back the reading from
    # before it, and inferring "decided" there would turn every blob that reading
    # changed into a hard lock nobody set.
    explicit = bool(new.get("explicit"))
    ownership = new.get("ownership_explicit")
    if ownership is None:
        ownership = bool(blob.get("ownership_explicit")) or allocations != blob["allocations"]
    blob.update(
        role=role,
        explicit=explicit and not structural,
        ownership_explicit=bool(ownership),
        subtype=str(new.get("subtype", ""))[:32],
        subtype_explicit=(
            new.get("subtype_explicit") if new.get("subtype_explicit") is not None else bool(new.get("subtype"))
        ),
        exception=new.get("exception", ""),
        allocations=[{"word_id": a["word_id"], "paws": a["paws"]} for a in allocations],
    )
    if blob["explicit"]:
        blob["decision_source"] = "human"
    elif blob.get("decision_source") == "human":
        # Released: nobody has decided it now, and the next reading says who does.
        blob["decision_source"] = "search"


def _joinable(word_ids: list[int], references: dict[int, Doc], role: str) -> bool:
    """Whether one blob may be shared by these words: a body, over consecutive words
    of one aya — the only words a single piece of ink can join."""
    if role != "body":
        return False
    order = {ident: index for index, ident in enumerate(references)}
    places = sorted(order[ident] for ident in word_ids)
    return places == list(range(places[0], places[0] + len(places))) and (
        len({references[ident]["aya"] for ident in word_ids}) == 1
    )


def _require_context(mushaf: Mushaf, document: Doc) -> None:
    """Refuse to read a page across neighbouring lines that have since changed.

    Reading the page again aligns the ayat that cross its breaks against those
    lines' snapshots; if one of them was re-processed, re-reviewed or erased, the
    reading would place words against ink that is no longer there. Saving and
    confirming read nothing, so only a preview and an accepted one need this.
    """
    if not _context_current(mushaf, document.get("context", [])):
        _refuse("stale_context")


def preview(mushaf: Mushaf, page: int, data: Doc) -> Doc:
    """The draft with these edits, re-aligned — shown, never stored.

    Accepting it is the client's business: it sends the previewed state back as an
    ordinary draft save, which is what makes accepting one undoable action and
    discarding it no action at all.
    """
    review = _review(mushaf, page)
    if review is None or not review.payload.get("lines"):
        _refuse("not_processed", 422, page=page)
    edited = _apply_edits(mushaf, review, data)
    _require_context(mushaf, edited)
    document = align_document(
        mushaf,
        edited,
        affected_ayas=set(edited.get("pending_ayas", [])),
        calibration_locks=edited.get("profile", {}).get("mode") == "experimental",
    )
    document["pending_ayas"] = []
    document.pop("request", None)
    document.update(
        page=page,
        revision=review.revision,
        confirmed_revision=review.confirmed_revision,
        processed=True,
        stale=False,
        preview=True,
        words=_page_words(mushaf, page),
    )
    _attach_urls(mushaf, document)
    return document


def exceptions(document: Doc) -> list[Doc]:
    """What a confirmation must acknowledge: counts that do not close, flagged ink,
    and lines the last alignment could not settle."""
    found: list[Doc] = []
    for row in document.get("lines", []):
        assigned: dict[int, int] = {}
        for blob in row["blobs"]:
            if blob.get("exception"):
                found.append(
                    {
                        "kind": "flagged",
                        "line_number": row["line_number"],
                        "blob": blob["id"],
                        "detail": blob["exception"],
                    }
                )
            if blob["role"] == "body":
                for allocation in blob.get("allocations", []):
                    assigned[allocation["word_id"]] = assigned.get(allocation["word_id"], 0) + allocation["paws"]
        for word in row["words"]:
            if word["word_id"] is None:
                continue
            got = assigned.get(word["word_id"], 0)
            if got != word["expected_paws"]:
                found.append(
                    {
                        "kind": "paw-count",
                        "line_number": row["line_number"],
                        "word_id": word["word_id"],
                        "detail": f"{word['text']}: {got}/{word['expected_paws']}",
                    }
                )
        if row.get("status") in ("partial", "unresolved"):
            found.append({"kind": "unresolved", "line_number": row["line_number"], "detail": row.get("reason") or ""})
    return found


def _request_hash(data: Doc, confirm: bool) -> str:
    return snapshots.digest({"data": {k: v for k, v in data.items() if k != "request_id"}, "confirm": confirm})


@transaction.atomic
def save(mushaf: Mushaf, page: int, data: Doc, *, confirm: bool = False, user: User | None = None) -> Doc:
    """Store the reviewer's edits as the draft — and, with ``confirm``, approve the page.

    Idempotent per ``request_id``: a retried request that already landed returns the
    current state instead of applying twice, and a *different* request reusing the
    id is refused. A confirmation additionally writes the page's words (the product)
    and an immutable ``confirmed`` revision — the only thing examples come from.
    Counts that do not close are allowed, but only when acknowledged.

    ``realign`` is how a preview is accepted. The edits carry decisions and edges,
    never the engine's verdicts — a line's status, a blob's attention — so storing
    them as they came would keep the verdicts of the reading *before* the preview.
    The page is read again under the same edits instead; the search is
    deterministic, so what is stored is what the preview showed.
    """
    # Match the ordinary word editor's Page -> Review lock order.
    page_row = Page.objects.select_for_update().filter(mushaf=mushaf, page_number=page).first()
    review = CalibrationReview.objects.select_for_update().filter(mushaf=mushaf, page_number=page).first()
    if review is None or not review.payload.get("lines"):
        _refuse("not_processed", 422, page=page)
    request_id = str(data["request_id"])
    request_hash = _request_hash(data, confirm)
    landed = review.payload.get("request") or {}
    previous = CalibrationRevision.objects.filter(review=review, request_id=request_id).first()
    if previous is not None or landed.get("id") == request_id:
        if (previous.payload.get("request_hash") if previous else landed.get("hash")) != request_hash:
            _refuse("request_reused")
        return page_document(mushaf, page)

    document = _apply_edits(mushaf, review, data)
    if data.get("realign"):
        _require_context(mushaf, document)
        document = align_document(
            mushaf,
            document,
            affected_ayas=set(document.get("pending_ayas", [])),
            calibration_locks=document.get("profile", {}).get("mode") == "experimental",
        )
        document["pending_ayas"] = []
    if confirm:
        found = exceptions(document)
        if found and not data.get("acknowledge_exceptions"):
            _refuse("exceptions", 422, count=len(found))
        if page_row is None:
            _refuse("stale_source")
        word_coordinates.replace_page_words(
            page_row,
            [
                {
                    "line_id": uuid.UUID(row["line_id"]),
                    "words": [{key: word[key] for key in ("word_id", "start_x", "end_x")} for word in row["words"]],
                }
                for row in document["lines"]
            ],
            counting_system=_system(mushaf),
            preserve_legacy=False,
        )
    review.revision += 1
    document["request"] = {"id": request_id, "hash": request_hash}
    if confirm:
        review.confirmed_revision = review.revision
        CalibrationRevision.objects.create(
            review=review,
            number=review.revision,
            kind=CalibrationRevisionKind.CONFIRMED,
            payload={**_record(document), "request_hash": request_hash, "acknowledged": exceptions(document)},
            request_id=request_id,
        )
    review.payload = document
    review.save(update_fields=["revision", "confirmed_revision", "payload", "updated_at"])
    activity.emit(
        mushaf,
        ActivityTypeChoices.CALIBRATION_CONFIRMED if confirm else ActivityTypeChoices.CALIBRATION_SAVED,
        {"page_number": page, "revision": review.revision},
        actor=user,
    )
    return page_document(mushaf, page)


# ---------------------------------------------------------------------------
# Mark types: a guess for every mark nobody has typed
# ---------------------------------------------------------------------------
def _typed(blob: Doc) -> bool:
    """A mark a person gave a type to — the only kind that may teach a type.

    A type with no ``subtype_explicit`` predates the flag, and every type then was
    set by hand. Flagged ink teaches nothing, as for roles.
    """
    return (
        blob["role"] == "mark"
        and bool(blob.get("subtype"))
        and bool(blob.get("subtype_explicit", True))
        and not blob.get("exception")
    )


def _typed_samples(stored: dict[str, CalibrationSnapshot], rows: list[Doc]) -> list[Doc]:
    samples = []
    for row in rows:
        snapshot = stored.get(row["snapshot_id"])
        typed = [blob for blob in row["blobs"] if _typed(blob)]
        if snapshot is None or not typed:
            continue
        features = snapshots.blob_features(snapshot)
        for blob in typed:
            if blob["id"] in features:
                samples.append(
                    {
                        "features": features[blob["id"]],
                        "subtype": blob["subtype"],
                        "snapshot_id": row["snapshot_id"],
                        "blob_id": blob["id"],
                    }
                )
    return samples


#: The confirmed pages' typed marks, by mushaf and the approvals they came from —
#: recomputed only when a confirmation changes. Bounded: each holds descriptors.
_TYPED: OrderedDict[tuple[str, tuple[str, ...]], list[Doc]] = OrderedDict()
_TYPED_MAX = 2


def _confirmed_types(mushaf: Mushaf, page: int) -> list[Doc]:
    """Every mark typed on every confirmed page except this one."""
    approvals = [revision for number, revision in _approvals(mushaf) if number != page]
    key = (str(mushaf.pk), tuple(str(revision.pk) for revision in approvals))
    cached = _TYPED.get(key)
    if cached is not None:
        _TYPED.move_to_end(key)
        return cached
    rows = [row for revision in approvals for row in revision.payload.get("lines", [])]
    stored = {
        str(s.pk): s
        for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in={row["snapshot_id"] for row in rows})
    }
    samples = _typed_samples(stored, rows)
    _TYPED[key] = samples
    while len(_TYPED) > _TYPED_MAX:
        _TYPED.popitem(last=False)
    return samples


def _page_marks(mushaf: Mushaf, rows: list[Doc]) -> tuple[dict[str, CalibrationSnapshot], list[tuple[Doc, Doc, Any]]]:
    """The rows' snapshots by id, and every mark on them with its descriptor."""
    stored = {
        str(s.pk): s
        for s in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[row["snapshot_id"] for row in rows])
    }
    marks: list[tuple[Doc, Doc, Any]] = []
    for row in rows:
        snapshot = stored.get(row["snapshot_id"])
        if snapshot is None or not any(blob["role"] == "mark" for blob in row["blobs"]):
            continue
        features = snapshots.blob_features(snapshot)
        marks += [
            (row, blob, features[blob["id"]])
            for blob in row["blobs"]
            if blob["role"] == "mark" and blob["id"] in features
        ]
    return stored, marks


def type_suggestions(mushaf: Mushaf, page: int, data: Doc) -> Doc:
    """A type for every mark on the page that nobody has typed yet, and a doubt on
    every typed one the other pages disagree with. Stores nothing.

    Learned from the marks typed on every confirmed page -- all of them, not only the
    earlier ones: these are hints for a person to accept or correct, not predictions
    under evaluation -- and from the marks already typed on this page, sent with the
    draft, so typing a few teaches the rest at once. A hint is never a label: it
    teaches nothing until it is accepted, which makes it a typed mark like any other.

    A **doubt** asks the other pages alone about a mark typed here, and is raised when
    they name another type: most often a slip of the hand, and a slip on a confirmed
    page teaches every page after it. Only for a type the other pages have examples
    of -- a first waqf sign is not doubtful for being the first.
    """
    review = _review(mushaf, page)
    if review is None or not review.payload.get("lines"):
        _refuse("not_processed", 422, page=page)
    rows = _apply_edits(mushaf, review, data)["lines"]
    stored, marks = _page_marks(mushaf, rows)
    here = _typed_samples(stored, rows)
    confirmed = _confirmed_types(mushaf, page)
    untyped = [mark for mark in marks if not _typed(mark[1])]
    typed = [mark for mark in marks if _typed(mark[1])]
    guesses = predict_types([features for _, _, features in untyped], build_type_index(confirmed + here))
    suggestions = [
        {
            "snapshot_id": row["snapshot_id"],
            "blob_id": blob["id"],
            "subtype": found["subtype"],
            "confidence": found["confidence"],
            "sure": found["sure"],
        }
        for (row, blob, _), found in zip(untyped, guesses, strict=True)
        if found["subtype"]
    ]
    elsewhere = build_type_index(confirmed)
    known = set(elsewhere.types)
    checks = predict_types([features for _, _, features in typed], elsewhere)
    doubts = [
        {
            "snapshot_id": row["snapshot_id"],
            "blob_id": blob["id"],
            "typed": blob["subtype"],
            "subtype": found["subtype"],
            "sure": found["sure"],
        }
        for (row, blob, _), found in zip(typed, checks, strict=True)
        if found["subtype"] and found["subtype"] != blob["subtype"] and blob["subtype"] in known
    ]
    return {"suggestions": suggestions, "doubts": doubts, "examples": len(confirmed), "typed_here": len(here)}


def type_evidence(mushaf: Mushaf, page: int, data: Doc) -> Doc:
    """Why one mark is expected to be what it is: the types nearest it, each with its
    own nearest typed examples -- pictures a person can judge. Stores nothing.

    Asked of what :func:`type_suggestions` asks: for an untyped mark, every confirmed
    page and the marks typed here; for a typed one, the other pages only -- the
    question its doubt asks.
    """
    review = _review(mushaf, page)
    if review is None or not review.payload.get("lines"):
        _refuse("not_processed", 422, page=page)
    rows = _apply_edits(mushaf, review, data)["lines"]
    stored, marks = _page_marks(mushaf, rows)
    found = next(
        (
            (blob, features)
            for row, blob, features in marks
            if row["snapshot_id"] == data["snapshot_id"] and blob["id"] == data["blob_id"]
        ),
        None,
    )
    if found is None:
        _refuse("not_found", 404, page=page)
    blob, features = found
    confirmed = _confirmed_types(mushaf, page)
    index = build_type_index(confirmed if _typed(blob) else confirmed + _typed_samples(stored, rows))
    candidates = nearest_by_type(features, index)
    sources = {
        str(s.pk): s
        for s in CalibrationSnapshot.objects.filter(
            mushaf=mushaf, pk__in={example["snapshot_id"] for entry in candidates for example in entry["examples"]}
        )
    }
    for entry in candidates:
        shown = []
        for example in entry["examples"]:
            source = sources.get(example["snapshot_id"])
            blobs = source.metadata["blobs"] if source is not None else []
            raw = next((b for b in blobs if b["label"] == example["blob_id"]), None)
            if source is None or raw is None:
                continue
            shown.append(
                {
                    **example,
                    "page_number": source.page_number,
                    "line_number": source.line_number,
                    "image_url": source.image.url,
                    "crop": {
                        "x": raw["x"] + source.metadata["offset_x"],
                        "y": raw["y"] + source.metadata["offset_y"],
                        "w": raw["w"],
                        "h": raw["h"],
                    },
                }
            )
        entry["examples"] = shown
    return {
        "snapshot_id": data["snapshot_id"],
        "blob_id": data["blob_id"],
        "typed": _typed(blob),
        "candidates": candidates,
    }


# ---------------------------------------------------------------------------
# The inspector
# ---------------------------------------------------------------------------
def examples(mushaf: Mushaf, page: int, snapshot_id: str, blob_id: int) -> Doc:
    """The confirmed examples nearest one blob, and what they propose.

    Asked on demand rather than stored with the page: five neighbours for each of a
    thousand blobs is most of a page's weight, and a reviewer looks at a few.

    From the profile the page was *processed* with — the one that made the proposal
    being explained — not from today's approvals, which may have changed since.
    """
    snapshot = CalibrationSnapshot.objects.filter(mushaf=mushaf, pk=snapshot_id).first()
    if snapshot is None:
        _refuse("not_found", 404, page=page)
    features = snapshots.blob_features(snapshot).get(blob_id)
    review = _review(mushaf, page)
    recorded = (review.payload.get("profile") or {}).get("signature") if review else None
    profile = CalibrationProfile.objects.filter(mushaf=mushaf, signature=recorded).first() if recorded else None
    prepared = _prepared(mushaf, profile) if profile is not None else profile_for(mushaf, page)[1]
    if features is None or not prepared.roles:
        return {"proposed_role": None, "confidence": 0.0, "reasons": ["no_examples"], "neighbors": [], "mode": "shadow"}
    found = predict_prepared(features, prepared)
    stored = {
        str(s.pk): s
        for s in CalibrationSnapshot.objects.filter(
            mushaf=mushaf, pk__in=[neighbor["snapshot_id"] for neighbor in found["neighbors"]]
        )
    }
    neighbors = []
    for neighbor in found["neighbors"]:
        source = stored.get(neighbor["snapshot_id"])
        raw = next((b for b in (source.metadata["blobs"] if source else []) if b["label"] == neighbor["blob_id"]), None)
        neighbors.append(
            {
                "snapshot_id": neighbor["snapshot_id"],
                "blob_id": neighbor["blob_id"],
                "page_number": neighbor["page_number"],
                "line_number": neighbor["line_number"],
                "role": neighbor["role"],
                "subtype": neighbor.get("subtype", ""),
                "distance": round(neighbor["distance"], 4),
                "copies": len(neighbor["refs"]),
                "image_url": source.image.url if source else None,
                "crop": (
                    {
                        "x": raw["x"] + source.metadata["offset_x"],
                        "y": raw["y"] + source.metadata["offset_y"],
                        "w": raw["w"],
                        "h": raw["h"],
                    }
                    if raw and source
                    else None
                ),
            }
        )
    return {
        "proposed_role": found["proposed_role"],
        "confidence": found["confidence"],
        "reasons": found["reasons"],
        "support_count": found["support_count"],
        "distinct_pages": found["distinct_pages"],
        "neighbors": neighbors,
        "mode": "shadow",
    }


# ---------------------------------------------------------------------------
# The evaluation gate
# ---------------------------------------------------------------------------
def evaluation_page(mushaf: Mushaf, page: int) -> Doc:
    """Render-ready historical readings; never use the current draft as truth."""
    review = _review(mushaf, page)
    confirmed = _approval(review) if review is not None else None
    processed = (
        CalibrationRevision.objects.filter(
            review=review,
            number=confirmed.payload.get("processed_revision"),
            kind=CalibrationRevisionKind.PROCESSED,
        ).first()
        if confirmed is not None
        else None
    )
    if processed is None or confirmed is None:
        _refuse("not_found", 404, page=page)
    canonical = processed.payload
    readings = {
        "frozen": canonical.get("frozen", {}),
        "canonical": canonical,
        "calibrated": _calibrated(mushaf, canonical),
        "confirmed": confirmed.payload,
    }
    reference = copy.deepcopy(confirmed.payload)
    _attach_urls(mushaf, reference)
    lines = []
    for row in reference.get("lines", []):
        variants = {}
        for name, document in readings.items():
            match = next(
                (
                    candidate
                    for candidate in document.get("lines", [])
                    if candidate.get("page_number", page) == page and candidate["line_number"] == row["line_number"]
                ),
                None,
            )
            variants[name] = {
                "words": match["words"] if match else [],
                "unavailable": bool(document.get("error")),
            }
        lines.append(
            {
                "line_number": row["line_number"],
                "bbox": row["bbox"],
                "image_url": row.get("image_url"),
                "readings": variants,
            }
        )
    return {
        "page": page,
        "confirmed_revision": confirmed.number,
        "processed_revision": processed.number,
        "profile": canonical.get("profile", {}),
        "lines": lines,
    }


def evaluation(mushaf: Mushaf) -> Doc:
    """How each confirmed page's automatic results compare with what was confirmed.

    Three results per page, all measured against the confirmation:

    * **frozen** — the engine as frozen, on its cropped-line path (word edges only);
    * **canonical** — full-line measurement, no locks: what the reviewer was shown;
    * **calibrated** — the same with calibration's proposals applied as locks.

    Every proposal was made from confirmed pages *before* its own, so a later page is
    a test the earlier ones never saw. Lock errors are counted separately for body
    and mark. Nothing here switches anything on: the gate is a person reading this.
    """
    pages = []
    for review in CalibrationReview.objects.filter(mushaf=mushaf, confirmed_revision__isnull=False).order_by(
        "page_number"
    ):
        confirmed = _approval(review)
        if confirmed is None:
            continue
        processed = CalibrationRevision.objects.filter(
            review=review,
            number=confirmed.payload.get("processed_revision"),
            kind=CalibrationRevisionKind.PROCESSED,
        ).first()
        if processed is None:
            continue
        pages.append(_evaluate_page(mushaf, review.page_number, processed.payload, confirmed.payload))
    totals: Doc = {}
    for entry in pages:
        for name, counts in entry["results"].items():
            bucket = totals.setdefault(name, {})
            for key, value in counts.items():
                bucket[key] = bucket.get(key, 0) + value
    return {
        "mode": "shadow",
        "activation_allowed": False,
        "gate": "user-review-required",
        "confirmed_pages": len(pages),
        "totals": totals,
        "pages": pages,
    }


def _evaluate_page(mushaf: Mushaf, page: int, processed: Doc, confirmed: Doc) -> Doc:
    truth = {
        (row["snapshot_id"], blob["id"]): blob["role"]
        for row in confirmed.get("lines", [])
        for blob in row["blobs"]
        if blob["role"] in TEXT_ROLES
    }
    truth_words = _placements(confirmed.get("lines", []), page)
    canonical = processed
    calibrated = _calibrated(mushaf, processed)
    frozen = _placements(processed.get("frozen", {}).get("lines", []), page)
    results = {
        "frozen": _word_errors(frozen, truth_words, page),
        "canonical": {
            **_role_errors(canonical, truth),
            **_word_errors(_placements_of(canonical, page), truth_words, page),
        },
        "calibrated": {
            **_role_errors(calibrated, truth),
            **_word_errors(_placements_of(calibrated, page), truth_words, page),
        },
    }
    proposals = {"body": {"made": 0, "wrong": 0}, "mark": {"made": 0, "wrong": 0}}
    for row in processed.get("lines", []):
        for blob in row["blobs"]:
            proposed = blob.get("proposed_role")
            key = (row["snapshot_id"], blob["id"])
            if proposed in proposals and key in truth:
                proposals[proposed]["made"] += 1
                proposals[proposed]["wrong"] += truth[key] != proposed
    released = sum("released-lock" in blob["attention"] for row in calibrated.get("lines", []) for blob in row["blobs"])
    return {
        "page": page,
        "profile": processed.get("profile", {}),
        "blobs": len(truth),
        "words": len(truth_words),
        "proposals": proposals,
        "released_locks": released,
        "results": results,
    }


def _calibrated(mushaf: Mushaf, processed: Doc) -> Doc:
    """The processed page re-read with its own proposals applied as locks."""
    document = copy.deepcopy(processed)
    document.setdefault("context", [])
    for row in document["lines"]:
        row["words"] = [word for word in row["words"] if word.get("override")]
        for blob in row["blobs"]:
            blob.update(explicit=False, ownership_explicit=False, allocations=[], role=blob["initial_role"])
    try:
        return align_document(mushaf, document, calibration_locks=True)
    except Exception:  # a missing snapshot must not sink the whole report
        logger.exception("Calibrated re-read failed for page %s", processed.get("page"))
        return {"lines": [], "error": True}


#: Where a word was placed: its line (page, line number) and both edges.
Placement = tuple[tuple[int, int], int, int]


def _placements(rows: list[Doc], page: int) -> dict[int, list[Placement]]:
    """Every labelled word's placements, each with the line it is on.

    The line matters: a word placed on the wrong line at the right x is still wrong,
    and a word placed twice has been placed twice.
    """
    found: dict[int, list[Placement]] = {}
    for row in rows:
        line = (int(row.get("page_number", page)), int(row["line_number"]))
        for word in row["words"]:
            if word["word_id"]:
                found.setdefault(word["word_id"], []).append((line, word["start_x"], word["end_x"]))
    return found


def _placements_of(document: Doc, page: int) -> dict[int, list[Placement]]:
    """A reading's placements on the page *and* its context lines: a word of this
    page that the reading put on the neighbouring page is on the wrong line, which
    is a different mistake from not placing it."""
    return _placements(document.get("lines", []) + document.get("context", []), page)


def _role_errors(document: Doc, truth: dict[tuple[str, int], str]) -> Doc:
    wrong = {"body_as_mark": 0, "mark_as_body": 0}
    for row in document.get("lines", []):
        for blob in row["blobs"]:
            expected = truth.get((row["snapshot_id"], blob["id"]))
            if expected is None or blob["role"] == expected:
                continue
            wrong["body_as_mark" if expected == "body" else "mark_as_body"] += 1
    return wrong


def _word_errors(found: dict[int, list[Placement]], truth: dict[int, list[Placement]], page: int) -> Doc:
    """How one reading's words differ from the confirmed ones, one count per way.

    * **moved** — on the right line, with an edge off by more than ``EDGE_TOLERANCE``;
    * **wrong line** — placed, but on another line than the confirmation's;
    * **missing** — not placed at all;
    * **duplicated** — placed more than once;
    * **extra** — placed on this page, though the confirmation has no such word here.
    """
    counts = {"words_moved": 0, "words_wrong_line": 0, "words_missing": 0, "words_duplicated": 0, "words_extra": 0}
    for word_id, confirmed in truth.items():
        line, start, end = confirmed[0]
        places = found.get(word_id, [])
        if not places:
            counts["words_missing"] += 1
            continue
        if len(places) > 1:
            counts["words_duplicated"] += 1
        same = [place for place in places if place[0] == line]
        if not same:
            counts["words_wrong_line"] += 1
        elif abs(same[0][1] - start) > EDGE_TOLERANCE or abs(same[0][2] - end) > EDGE_TOLERANCE:
            counts["words_moved"] += 1
    counts["words_extra"] = sum(
        1 for word_id, places in found.items() if word_id not in truth and any(place[0][0] == page for place in places)
    )
    return counts

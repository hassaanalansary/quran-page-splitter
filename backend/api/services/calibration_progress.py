"""How far calibration has come on a mushaf: each confirmed page's numbers, and the
readiness meter built from them.

``manage.py calibration_report`` prints :func:`measure`'s rows as a table; the
Calibrate panel shows :func:`readiness` as a meter. Both read only what is stored —
the prediction record each page was processed with, the draft as its reviewer first
saw it, and the confirmation — and change nothing.

**What the meter answers.** *Would processing the rest of the mushaf in bulk now
lose anything?* A batch processes every page with the learning as it stands when
the batch runs (see :mod:`api.services.calibration_batch`), so pages it processes
today never see the pages confirmed tomorrow. That costs little once the learning
has stopped growing and stays right, and once the pages need little fixing of what
calibration can fix. Four checks, each read off the latest confirmed pages::

    pages     enough confirmed pages to judge by at all
    trust     the learning's role proposals were never contradicted
    settled   the share of blobs it decides has stopped growing
    fixes     few roles and mark types needed fixing on the first draft

**What it cannot see.** A mistake nobody corrected looks like a page that needed no
fixing. The word search is not taught by calibration, so the words a page needs
fixing are reported beside the meter, not scored by it. It is an estimate meant to
say when to stop going one page at a time — not that the drafts will be right.
"""

from __future__ import annotations

import statistics
from typing import Any

from api.models import (
    CalibrationReview,
    CalibrationRevision,
    CalibrationRevisionKind,
    Mushaf,
    ProcessJob,
    ProcessJobKindChoices,
    ProcessJobStateChoices,
)
from api.services import calibration
from core.text import SMALL_LETTERS

Doc = dict[str, Any]

#: Confirmed pages before the meter says much. On the first mushaf the learning's
#: share of blobs climbed from 15% to 75% over its pages 3-11 and was almost flat
#: over the last three; eight ordinary pages is about where it settled.
ENOUGH_PAGES = 8
#: The latest confirmed pages whose proposals the trust check counts.
TRUST_PAGES = 5
#: Each wrong proposal per hundred made costs the trust check this much of its score,
#: so one in a hundred halves it and two in a hundred empty it.
TRUST_PENALTY = 50
#: The latest confirmed pages whose growth the settled check fits a line through.
SETTLED_PAGES = 5
#: Growth of the learning's share, in percentage points per page: at or under the
#: first it has settled; at or over the second it is still climbing fast.
SETTLED_GROWTH = (2.0, 10.0)
#: The latest confirmed pages with a first draft that the fixes check reads.
FIX_PAGES = 3
#: Roles and mark types fixed per thousand blobs: at or under the first, little is
#: left to fix; at or over the second, a page still needs a lot. The first mushaf's
#: pages 2-6 ran 4-8 after the text rules, its page 1 — no examples yet — 230.
FIX_RATE = (5.0, 25.0)
#: Score at or above which the meter says ready, and at or above which close.
READY, CLOSE = 80, 50
#: The latest confirmed pages the meter measures: its checks read five or fewer, its
#: chart these. Measuring a finished mushaf whole would read two full revisions of each
#: of six hundred pages, on every visit, to draw the same meter.
METER_PAGES = 30


# ---------------------------------------------------------------------------
# Each confirmed page's numbers
# ---------------------------------------------------------------------------
def measure(mushaf: Mushaf, *, latest: int | None = None) -> list[Doc]:
    """Every confirmed page's row — or the ``latest`` few's — in page order.

    Each measured against its confirmation: the engine's and the learning's roles
    from the prediction record, and — for a page processed since 2026-10-01, which
    keeps the draft as it was first shown (``first_draft``) — what the reviewer
    corrected on it. ``minutes`` runs from processing to the first confirmation
    after it, breaks included.
    """
    rows = []
    reviews = CalibrationReview.objects.filter(mushaf=mushaf, confirmed_revision__isnull=False)
    chosen = (
        list(reviews.order_by("page_number"))
        if latest is None
        else list(reviews.order_by("-page_number")[:latest])[::-1]
    )
    for review in chosen:
        confirmed = calibration._approval(review)
        if confirmed is None:
            continue
        processed = CalibrationRevision.objects.filter(
            review=review, number=confirmed.payload.get("processed_revision"), kind=CalibrationRevisionKind.PROCESSED
        ).first()
        if processed is None:
            continue
        # Time is measured to the page's first confirmation after it was processed: a
        # later re-confirmation is a correction, not how long the page took.
        finished = (
            CalibrationRevision.objects.filter(
                review=review, kind=CalibrationRevisionKind.CONFIRMED, number__gt=processed.number
            )
            .order_by("number")
            .values_list("created_at", flat=True)
            .first()
        )
        rows.append(_page(review.page_number, processed, confirmed, finished or confirmed.created_at))
    return rows


def _page(page: int, processed: CalibrationRevision, confirmed: CalibrationRevision, finished: Any) -> Doc:
    final = {
        (row["snapshot_id"], blob["id"]): blob for row in confirmed.payload.get("lines", []) for blob in row["blobs"]
    }
    text = {key for key, blob in final.items() if blob["role"] in calibration.TEXT_ROLES and not blob.get("erased")}
    engine = learned = learned_wrong = 0
    for row in processed.payload.get("lines", []):
        for blob in row["blobs"]:
            key = (row["snapshot_id"], blob["id"])
            if key not in text:
                continue
            right = final[key]["role"]
            engine += blob["role"] != right
            if blob.get("proposed_role") in calibration.TEXT_ROLES:
                learned += 1
                learned_wrong += blob["proposed_role"] != right
    truth = calibration._placements(confirmed.payload.get("lines", []), page)
    found: Doc = {
        "page": page,
        "blobs": len(text),
        "words_total": len(truth),
        "engine_wrong": engine,
        "learned": learned,
        "learned_wrong": learned_wrong,
        "minutes": max(0, round((finished - processed.created_at).total_seconds() / 60)),
    }
    shown = processed.payload.get("shown")
    if shown is None:
        found.update(
            first_draft=False, words=_different(calibration._placements_of(processed.payload, page), truth, page)
        )
        return found
    counts = dict.fromkeys(("looks", "roles", "by_text", "text_changed", "locks", "locks_undone", "by_hand"), 0)
    for row in shown["lines"]:
        for ident, first in row["blobs"].items():
            blob = final.get((row["snapshot_id"], int(ident)))
            if blob is None or blob.get("erased"):
                continue
            small = blob["role"] == "mark" and blob.get("subtype") in SMALL_LETTERS
            counts["looks"] += first["look"]
            counts["roles"] += first["role"] != blob["role"]
            if first["by_text"]:
                counts["by_text"] += 1
                counts["text_changed"] += blob["role"] != "mark" or blob.get("subtype", "") != first["subtype"]
            if first["text_lock"]:
                counts["locks"] += 1
                counts["locks_undone"] += not small
            elif small and first["role"] == "body":
                counts["by_hand"] += 1
    drafted = [
        {
            "line_number": row["line_number"],
            "words": [{"word_id": w, "start_x": s, "end_x": e} for w, s, e in row["words"]],
        }
        for row in shown["lines"]
    ]
    found.update(counts, first_draft=True, words=_different(calibration._placements(drafted, page), truth, page))
    return found


def _different(
    found: dict[int, list[calibration.Placement]], truth: dict[int, list[calibration.Placement]], page: int
) -> int:
    """How many words were placed otherwise than confirmed — moved, on another line,
    missing, doubled or extra."""
    return sum(calibration._word_errors(found, truth, page).values())


def fixes(row: Doc) -> int:
    """What the reviewer corrected on a first draft that calibration and the text
    could have got right: roles, the text's types, its small letters either way."""
    return int(row["roles"] + row["text_changed"] + row["locks_undone"] + row["by_hand"])


# ---------------------------------------------------------------------------
# The meter
# ---------------------------------------------------------------------------
def readiness(mushaf: Mushaf) -> Doc:
    """The readiness meter: a score from 0 to 100, its level, the four checks behind
    it, each confirmed page's numbers for the chart, and what a page costs.

    Each check scores 0 to 1 and says ``pass``, ``near``, ``fail`` — or ``unknown``
    when there are not yet the pages to tell. The score is their mean, held under
    *close* while the trust check fails: a batch would lock the learning's mistakes
    into every page it processes.
    """
    rows = measure(mushaf, latest=METER_PAGES)
    confirmed = CalibrationReview.objects.filter(mushaf=mushaf, confirmed_revision__isnull=False).count()
    checks = [_pages_check(confirmed), _trust_check(rows), _settled_check(rows), _fixes_check(rows)]
    score = round(100 * sum(check["score"] for check in checks) / len(checks))
    if checks[1]["state"] == "fail":
        score = min(score, CLOSE - 1)
    return {
        "score": score,
        "level": "ready" if score >= READY else "close" if score >= CLOSE else "keep",
        "checks": checks,
        "pages": [
            {
                "page": row["page"],
                "blobs": row["blobs"],
                "coverage": _share(row),
                "learned_wrong": row["learned_wrong"],
                "fixes": fixes(row) if row["first_draft"] else None,
                "words": row["words"],
                "words_total": row["words_total"],
                "minutes": row["minutes"],
            }
            for row in rows
        ],
        "cost": cost(mushaf, rows),
        "experimental": calibration.settings_document(mushaf)["experimental"],
    }


def _share(row: Doc) -> float:
    """The share of a page's text blobs the learning proposed a role for, in percent."""
    return round(100 * row["learned"] / row["blobs"], 1) if row["blobs"] else 0.0


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _between(value: float, good: float, bad: float) -> float:
    """1 at ``good`` or better, 0 at ``bad`` or worse, a straight line between."""
    return _clamp((bad - value) / (bad - good))


def _pages_check(count: int) -> Doc:
    return {
        "key": "pages",
        "score": round(_clamp(count / ENOUGH_PAGES), 3),
        "state": "pass" if count >= ENOUGH_PAGES else "near" if count >= ENOUGH_PAGES // 2 else "fail",
        "values": {"count": count, "target": ENOUGH_PAGES},
    }


def _trust_check(rows: list[Doc]) -> Doc:
    recent = rows[-TRUST_PAGES:]
    made = sum(row["learned"] for row in recent)
    wrong = sum(row["learned_wrong"] for row in recent)
    values = {"made": made, "wrong": wrong, "pages": len(recent)}
    if not made:
        return {"key": "trust", "score": 0.0, "state": "unknown", "values": values}
    score = _clamp(1 - TRUST_PENALTY * wrong / made)
    state = "pass" if not wrong else "near" if score >= 0.8 else "fail"
    return {"key": "trust", "score": round(score, 3), "state": state, "values": values}


def _slope(points: list[tuple[float, float]]) -> float:
    """The least-squares slope through ``(x, y)`` points."""
    mean_x = statistics.fmean(x for x, _ in points)
    mean_y = statistics.fmean(y for _, y in points)
    spread = sum((x - mean_x) ** 2 for x, _ in points)
    return sum((x - mean_x) * (y - mean_y) for x, y in points) / spread if spread else 0.0


def _settled_check(rows: list[Doc]) -> Doc:
    """How fast the learning's share of each page is still growing, page over page.

    Fitted over the latest few confirmed pages, each counted as one step whatever
    its number — a page skipped is not a page the learning grew over.
    """
    recent = [row for row in rows if row["blobs"]][-SETTLED_PAGES:]
    shares = [_share(row) for row in recent]
    values: Doc = {"pages": len(recent), "latest": shares[-1] if shares else 0.0, "growth": None}
    if len(recent) < 3:
        return {"key": "settled", "score": 0.0, "state": "unknown", "values": values}
    growth = _slope(list(enumerate(shares)))
    values["growth"] = round(growth, 1)
    good, bad = SETTLED_GROWTH
    score = _between(growth, good, bad)
    state = "pass" if growth <= good else "near" if growth <= (good + bad) / 2 else "fail"
    return {"key": "settled", "score": round(score, 3), "state": state, "values": values}


def _fixes_check(rows: list[Doc]) -> Doc:
    recent = [row for row in rows if row["first_draft"]][-FIX_PAGES:]
    blobs = sum(row["blobs"] for row in recent)
    fixed = sum(fixes(row) for row in recent)
    values: Doc = {
        "pages": len(recent),
        "fixed": fixed,
        "rate": None,
        "per_page": round(fixed / len(recent), 1) if recent else None,
        "words_per_page": round(sum(row["words"] for row in recent) / len(recent), 1) if recent else None,
    }
    if not recent or not blobs:
        return {"key": "fixes", "score": 0.0, "state": "unknown", "values": values}
    rate = 1000 * fixed / blobs
    values["rate"] = round(rate, 1)
    good, bad = FIX_RATE
    score = _between(rate, good, bad)
    state = "pass" if rate <= good else "near" if rate <= (good + bad) / 2 else "fail"
    return {"key": "fixes", "score": round(score, 3), "state": state, "values": values}


def cost(mushaf: Mushaf, rows: list[Doc] | None = None) -> Doc:
    """What a page costs: processing, from the mushaf's finished calibration jobs, and
    review, from the latest confirmed pages in ``rows`` — what a batch's estimate is
    made of. Without ``rows``, only the processing."""
    durations = [
        (ended - started).total_seconds()
        for started, ended in ProcessJob.objects.filter(
            mushaf=mushaf,
            kind=ProcessJobKindChoices.CALIBRATION,
            state=ProcessJobStateChoices.COMPLETED,
            ended_at__isnull=False,
        )
        .order_by("-started_at")
        .values_list("started_at", "ended_at")[:20]
        if ended is not None
    ]
    for report in (
        ProcessJob.objects.filter(mushaf=mushaf, kind=ProcessJobKindChoices.CALIBRATION_BATCH, report__isnull=False)
        .order_by("-started_at")
        .values_list("report", flat=True)[:5]
    ):
        processed = len((report or {}).get("processed", []))
        if processed and report and report.get("busy_seconds"):
            durations.append(report["busy_seconds"] / processed)
    recent = [row["minutes"] for row in (rows or [])[-FIX_PAGES:]]
    return {
        "process_seconds": round(statistics.median(durations)) if durations else None,
        "review_minutes": round(statistics.median(recent)) if recent else None,
    }

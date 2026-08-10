"""Page-editing orchestration: read a page, save edited coordinates, finalize.

Views call these; this layer owns the ORM and delegates mapping/renumbering to
``coordinates``. Numbering is derived (no anchors): saving a page rewrites its
rows from the payload, then recomputes aya numbers forward.
"""

import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from django.db import transaction
from django.db.models import Count, Q
from ninja.errors import HttpError

from api import i18n, validators
from api.models import ActivityTypeChoices, EraseStroke, Line, LineTypeChoices, Mushaf, Page, Segment
from api.services import activity, coordinates
from api.services import mushaf as mushaf_service


def get_page_data(mushaf_id: uuid.UUID, page_number: int) -> dict:
    """Coordinate data for a logical page; empty (no lines) if not yet processed."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    validators.validate_page_number(mushaf, page_number)
    page = Page.objects.filter(mushaf=mushaf, page_number=page_number).first()
    if page is None:
        return {"page_number": page_number, "bbox": None, "lines": []}
    return coordinates.page_to_dict(page)


def list_pages(mushaf_id: uuid.UUID) -> list[dict]:
    """Per-page summaries: review state + detection counts (rail map + Pages tab).

    ``ayat`` counts aya-closing segments (``has_separator=True``);
    ``source_pdf_page`` is the resolved physical page (override or derived).
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    rows = (
        Page.objects.filter(mushaf=mushaf)
        .annotate(
            lines_count=Count("lines", distinct=True),
            segments_count=Count("lines__segments", distinct=True),
            ayat_count=Count("lines__segments", filter=Q(lines__segments__has_separator=True), distinct=True),
            headers_count=Count("lines", filter=Q(lines__type=LineTypeChoices.SURA_HEADER), distinct=True),
        )
        .values(
            "page_number",
            "reviewed",
            "source_pdf_page",
            "lines_count",
            "segments_count",
            "ayat_count",
            "headers_count",
        )
        .order_by("page_number")
    )
    suras_by_page = _suras_by_page(mushaf)
    return [
        {
            "page_number": row["page_number"],
            "reviewed": row["reviewed"],
            "source_pdf_page": row["source_pdf_page"] or mushaf.first_quran_pdf_page + row["page_number"] - 1,
            "lines": row["lines_count"],
            "ayat": row["ayat_count"],
            "segments": row["segments_count"],
            "has_header": row["headers_count"] > 0,
            "suras": suras_by_page.get(row["page_number"], []),
        }
        for row in rows
    ]


def _suras_by_page(mushaf: Mushaf) -> dict[int, list[dict]]:
    """Distinct suras appearing on each page (ordered by sura number)."""
    rows = (
        Line.objects.filter(page__mushaf=mushaf, sura__isnull=False)
        .values("page__page_number", "sura__number", "sura__transliteration", "sura__name_arabic")
        .distinct()
        .order_by("page__page_number", "sura__number")
    )
    result: dict[int, list[dict]] = {}
    for row in rows:
        result.setdefault(row["page__page_number"], []).append(
            {
                "number": row["sura__number"],
                "transliteration": row["sura__transliteration"],
                "name_arabic": row["sura__name_arabic"],
            }
        )
    return result


def save_page(*, mushaf_id: uuid.UUID, page_number: int, bbox: dict, lines: list[dict]) -> dict:
    """Replace a page's lines/segments from the payload, then renumber forward."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    validators.validate_page_number(mushaf, page_number)
    was_reviewed = Page.objects.filter(mushaf=mushaf, page_number=page_number, reviewed=True).exists()
    page, _ = Page.objects.update_or_create(
        mushaf=mushaf,
        page_number=page_number,
        defaults={
            "bbox_x": bbox["x"],
            "bbox_y": bbox["y"],
            "bbox_w": bbox["w"],
            "bbox_h": bbox["h"],
            "reviewed": True,
        },
    )
    page.lines.all().delete()
    for line_data in lines:
        _write_edited_line(page, line_data)
    coordinates.renumber_from(page)
    # Only the first review of a page (since its last processing) is feed-worthy.
    if not was_reviewed:
        activity.emit(mushaf, ActivityTypeChoices.REVIEW_SAVED, {"page_number": page_number})
    return coordinates.page_to_dict(page)


def _write_edited_line(page: Page, line_data: dict) -> None:
    line_type = line_data["type"]
    if line_type not in LineTypeChoices.values:
        raise HttpError(400, i18n.t("invalid_line_type", line_type=line_type))
    line = Line.objects.create(
        page=page,
        line_number=line_data["line_number"],
        type=line_type,
        sura_id=line_data.get("sura_number"),
        bbox_x=line_data["bbox_x"],
        bbox_y=line_data["bbox_y"],
        bbox_w=line_data["bbox_w"],
        bbox_h=line_data["bbox_h"],
    )
    segments = line_data.get("segments") or []
    if segments:
        Segment.objects.bulk_create(
            [
                Segment(
                    line=line,
                    segment_order=segment.get("segment_order", index),
                    bbox_x=segment["bbox_x"],
                    bbox_w=segment["bbox_w"],
                    has_separator=segment.get("has_separator", False),
                    aya_number=segment.get("aya_number"),
                )
                for index, segment in enumerate(segments, start=1)
            ]
        )


def save_finalize(*, mushaf_id: uuid.UUID, page_number: int, line_edits: list[dict]) -> dict:
    """Apply the cut layer: optional line bbox overrides + erase strokes.

    These never affect numbering (segments are independent of line bbox), so no
    renumber is needed — only the export crop/alpha are affected.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    page = Page.objects.filter(mushaf=mushaf, page_number=page_number).first()
    if page is None:
        raise HttpError(404, i18n.t("page_no_finalize"))
    lines_by_number = {line.line_number: line for line in page.lines.all()}
    for edit in line_edits:
        line = lines_by_number.get(edit["line_number"])
        if line is None:
            continue
        override = edit.get("bbox_override")
        if override:
            line.bbox_y, line.bbox_h = override["y"], override["h"]
            line.save(update_fields=["bbox_y", "bbox_h"])
        line.erase_strokes.all().delete()
        strokes = edit.get("erase_strokes") or []
        if strokes:
            EraseStroke.objects.bulk_create(
                [
                    EraseStroke(
                        line=line,
                        brush_size=stroke.get("brush_size", 12),
                        points=stroke.get("points", []),
                    )
                    for stroke in strokes
                ]
            )
    return coordinates.page_to_dict(page)


def review_data(mushaf_id: uuid.UUID) -> dict:
    """Whole-document payload for the review session: numbering seed + every page
    that currently has data (each with its ``reviewed`` flag).

    The seed is **logical page 1's** entry state, so manually added front pages
    number from the true start of the mushaf (page 1 = sura 1 aya 1 unless it was
    processed with a different start). The client fills in the blank pages 1..N.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    page_rows = list(
        Page.objects.filter(mushaf=mushaf)
        .order_by("page_number")
        .values(
            "id",
            "page_number",
            "reviewed",
            "bbox_x",
            "bbox_y",
            "bbox_w",
            "bbox_h",
            "last_run__settings",
        )
    )
    line_rows = (
        Line.objects.filter(page__mushaf=mushaf)
        .order_by("page_id", "line_number")
        .values("id", "page_id", "type", "sura_id", "bbox_x", "bbox_y", "bbox_w", "bbox_h")
    )
    # Only aya-closing segments become cuts — filter + skinny projection in SQL.
    cut_rows = (
        Segment.objects.filter(line__page__mushaf=mushaf, has_separator=True)
        .order_by("line_id", "segment_order")
        .values_list("line_id", "bbox_x")
    )

    cuts_by_line: dict = {}
    for line_id, bbox_x in cut_rows:
        cuts_by_line.setdefault(line_id, []).append(bbox_x)

    lines_by_page: dict = {}
    for line_row in line_rows:
        line: dict = {
            "type": line_row["type"],
            "sura_number": line_row["sura_id"],
            "bbox_x": line_row["bbox_x"],
            "bbox_y": line_row["bbox_y"],
            "bbox_w": line_row["bbox_w"],
            "bbox_h": line_row["bbox_h"],
        }
        if line_row["type"] == LineTypeChoices.TEXT:
            line["cuts"] = cuts_by_line.get(line_row["id"], [])
        lines_by_page.setdefault(line_row["page_id"], []).append(line)

    pages_out = []
    for page_row in page_rows:
        lines = lines_by_page.get(page_row["id"], [])
        pages_out.append(
            {
                "page_number": page_row["page_number"],
                "bbox": _page_column(page_row, lines),
                "lines": lines,
                "reviewed": page_row["reviewed"],
                "run_start": _run_start(page_row["last_run__settings"]),
            }
        )
    return {"start": _start(page_rows), "pages": pages_out}


def _page_column(page_row: Mapping[str, Any], lines: list[dict]) -> dict | None:
    """``coordinates.page_column`` over flat rows: the stored crop box, else the
    union of the page's line boxes (manual pages carry only a 1x1 placeholder)."""
    bx, bw = page_row["bbox_x"], page_row["bbox_w"]
    if bx is not None and bw is not None and bw > 1:
        return {"x": bx, "y": page_row["bbox_y"], "w": bw, "h": page_row["bbox_h"]}
    if not lines:
        if bx is None:
            return None
        return {"x": bx, "y": page_row["bbox_y"], "w": bw, "h": page_row["bbox_h"]}
    left = min(ln["bbox_x"] for ln in lines)
    top = min(ln["bbox_y"] for ln in lines)
    right = max(ln["bbox_x"] + ln["bbox_w"] for ln in lines)
    bottom = max(ln["bbox_y"] + ln["bbox_h"] for ln in lines)
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


def _run_start(settings: object) -> dict | None:
    """The (sura, aya) a page's run began at — the island seed used when a gap
    breaks numbering propagation. ``None`` for pages never processed by a run."""
    if not isinstance(settings, dict) or "start_sura" not in settings:
        return None
    return {"sura": int(settings.get("start_sura", 1)), "aya": int(settings.get("start_aya", 1))}


def _start(page_rows: Sequence[Mapping[str, Any]]) -> dict:
    """Logical page 1's entry state — its run's start (else 1:1) — so manual front
    pages number from the true start of the mushaf."""
    if page_rows and page_rows[0]["page_number"] == 1:
        settings = page_rows[0]["last_run__settings"]
        if isinstance(settings, dict):
            return {"sura": int(settings.get("start_sura", 1)), "aya": int(settings.get("start_aya", 1))}
    return {"sura": 1, "aya": 1}


def bulk_save(*, mushaf_id: uuid.UUID, pages: list[dict], reviewed_pages: list[int]) -> dict:
    """Persist edited pages + review flags in one transaction.

    ``pages`` entries are the ``save_page`` shape ({page_number, bbox, lines}).
    The **client owns the numbering** in the review session (island seeds + header
    sura anchors + separator-derived aya), so sura/aya are stored **verbatim** —
    this does NOT run ``renumber_from`` (that would overwrite the manual edits).
    Data writes do NOT flip ``reviewed`` — only ``reviewed_pages`` does.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    for entry in pages:
        validators.validate_page_number(mushaf, entry["page_number"])

    with transaction.atomic():
        for entry in sorted(pages, key=lambda e: e["page_number"]):
            bbox = entry["bbox"]
            page, _ = Page.objects.update_or_create(
                mushaf=mushaf,
                page_number=entry["page_number"],
                defaults={"bbox_x": bbox["x"], "bbox_y": bbox["y"], "bbox_w": bbox["w"], "bbox_h": bbox["h"]},
            )
            page.lines.all().delete()
            for line_data in entry["lines"]:
                _write_edited_line(page, line_data)

        newly_reviewed = sorted(
            Page.objects.filter(mushaf=mushaf, page_number__in=reviewed_pages, reviewed=False).values_list(
                "page_number", flat=True
            )
        )
        Page.objects.filter(mushaf=mushaf, page_number__in=reviewed_pages).update(reviewed=True)

        if len(newly_reviewed) == 1:
            activity.emit(mushaf, ActivityTypeChoices.REVIEW_SAVED, {"page_number": newly_reviewed[0]})
        elif newly_reviewed:
            activity.emit(
                mushaf,
                ActivityTypeChoices.REVIEW_SAVED,
                {"page_start": newly_reviewed[0], "page_end": newly_reviewed[-1], "count": len(newly_reviewed)},
            )

    return review_data(mushaf_id)

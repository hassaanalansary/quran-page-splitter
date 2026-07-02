"""Page-editing orchestration: read a page, save edited coordinates, finalize.

Views call these; this layer owns the ORM and delegates mapping/renumbering to
``coordinates``. Numbering is derived (no anchors): saving a page rewrites its
rows from the payload, then recomputes aya numbers forward.
"""

import uuid

from django.db.models import Count, Q
from ninja.errors import HttpError

from api import validators
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
        raise HttpError(400, f"Invalid line type {line_type!r}.")
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
        raise HttpError(404, "Page has no data to finalize.")
    lines_by_number = {line.line_number: line for line in page.lines.all()}
    for edit in line_edits:
        line = lines_by_number.get(edit["line_number"])
        if line is None:
            continue
        override = edit.get("bbox_override")
        if override:
            line.bbox_x, line.bbox_y = override["x"], override["y"]
            line.bbox_w, line.bbox_h = override["w"], override["h"]
            line.save(update_fields=["bbox_x", "bbox_y", "bbox_w", "bbox_h"])
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

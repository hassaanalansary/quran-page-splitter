"""ORM <-> coordinate mapping for pages, lines, and segments.

Three responsibilities:
  * ``write_coords_to_page`` — engine output dict -> rows (``basmala`` -> ``besmella``)
  * ``page_to_dict``         — rows -> editor dict (flat bbox fields, DB type values)
  * ``renumber_from``        — recompute sura/aya forward across consecutive pages
"""

from django.db.models import Prefetch, QuerySet

from api.models import Line, LineTypeChoices, Mushaf, Page, ProcessingRun, Segment

# Engine line-type string -> DB LineTypeChoices value.
_ENGINE_TO_DB_TYPE = {
    "sura_header": LineTypeChoices.SURA_HEADER,
    "basmala": LineTypeChoices.BESMELLA,
    "text": LineTypeChoices.TEXT,
}


# ---------------------------------------------------------------------------
# Write: engine coordinate dict -> rows
# ---------------------------------------------------------------------------
def write_coords_to_page(
    *, mushaf: Mushaf, page_number: int, run: ProcessingRun, coord_page: dict
) -> Page:
    """Persist one engine coordinate page into Page + Line + Segment rows.

    Replaces any existing rows for that logical page (reprocessing overwrites it).
    """
    crop = coord_page.get("crop_box")
    defaults: dict = {"last_run": run}
    if crop:
        defaults |= {
            "bbox_x": crop["x"],
            "bbox_y": crop["y"],
            "bbox_w": crop["w"],
            "bbox_h": crop["h"],
        }
    page, _ = Page.objects.update_or_create(
        mushaf=mushaf, page_number=page_number, defaults=defaults
    )
    page.lines.all().delete()
    for line_data in coord_page.get("lines", []):
        _write_engine_line(page, line_data)
    return page


def _write_engine_line(page: Page, line_data: dict) -> None:
    engine_type = line_data["type"]
    bbox = line_data["line_bbox"]
    line = Line.objects.create(
        page=page,
        line_number=line_data["line_number"],
        type=_ENGINE_TO_DB_TYPE[engine_type],
        sura_id=_engine_line_sura(line_data),
        bbox_x=bbox["x"],
        bbox_y=bbox["y"],
        bbox_w=bbox["w"],
        bbox_h=bbox["h"],
    )
    if engine_type == "text":
        Segment.objects.bulk_create(
            [
                Segment(
                    line=line,
                    segment_order=index,
                    bbox_x=segment["bbox"]["x"],
                    bbox_w=segment["bbox"]["w"],
                    has_separator=segment["has_separator"],
                    aya_number=segment["aya_number"],
                )
                for index, segment in enumerate(line_data.get("segments", []), start=1)
            ]
        )


def _engine_line_sura(line_data: dict) -> int | None:
    if line_data["type"] in ("sura_header", "basmala"):
        return line_data.get("sura_number")
    segments = line_data.get("segments", [])
    return segments[0].get("sura_number") if segments else None


# ---------------------------------------------------------------------------
# Read: rows -> editor dict (flat bbox fields, DB type values)
# ---------------------------------------------------------------------------
def page_to_dict(page: Page) -> dict:
    """Serialize a page's rows into the editor's coordinate representation."""
    return {
        "page_number": page.page_number,
        "bbox": _page_bbox(page),
        "lines": [_line_to_dict(line) for line in _ordered_lines(page)],
    }


def _ordered_lines(page: Page) -> QuerySet[Line]:
    return page.lines.order_by("line_number").prefetch_related(
        Prefetch("segments", queryset=Segment.objects.order_by("segment_order"))
    )


def _page_bbox(page: Page) -> dict | None:
    if page.bbox_x is None:
        return None
    return {"x": page.bbox_x, "y": page.bbox_y, "w": page.bbox_w, "h": page.bbox_h}


def _line_to_dict(line: Line) -> dict:
    return {
        "id": str(line.id),
        "line_number": line.line_number,
        "type": line.type,
        "sura_number": line.sura_id,
        "bbox_x": line.bbox_x,
        "bbox_y": line.bbox_y,
        "bbox_w": line.bbox_w,
        "bbox_h": line.bbox_h,
        "segments": [
            {
                "id": str(segment.id),
                "segment_order": segment.segment_order,
                "bbox_x": segment.bbox_x,
                "bbox_w": segment.bbox_w,
                "has_separator": segment.has_separator,
                "aya_number": segment.aya_number,
                "sura_number": line.sura_id,
            }
            for segment in line.segments.all()
        ],
    }


# ---------------------------------------------------------------------------
# Renumber: recompute sura/aya forward across consecutive pages
# ---------------------------------------------------------------------------
def renumber_from(page: Page) -> None:
    """Recompute sura/aya from ``page`` forward through consecutive pages.

    Seeded from the previous page's exit state (or the run's start for the first
    page). Stops at a page-number gap or once a page yields no change (the shift
    has converged, so everything downstream is already correct).
    """
    sura, aya = _entry_state(page)
    current: Page | None = page
    while current is not None:
        changed, (sura, aya) = _renumber_page(current, sura, aya)
        if not changed:
            break
        current = _consecutive(current, 1)


def _entry_state(page: Page) -> tuple[int, int]:
    previous = _consecutive(page, -1)
    if previous is not None:
        return _exit_state(previous)
    run = page.last_run
    if run is not None and isinstance(run.settings, dict):
        return (
            int(run.settings.get("start_sura", 1)),
            int(run.settings.get("start_aya", 1)),
        )
    return 1, 1


def _exit_state(page: Page) -> tuple[int, int]:
    last_line = page.lines.order_by("-line_number").first()
    if last_line is None:
        return 1, 1
    sura = last_line.sura_id or 1
    if last_line.type != LineTypeChoices.TEXT:
        return sura, 1
    last_seg = last_line.segments.order_by("-segment_order").first()
    if last_seg is None or last_seg.aya_number is None:
        return sura, 1
    return sura, last_seg.aya_number + (1 if last_seg.has_separator else 0)


def _renumber_page(page: Page, sura: int, aya: int) -> tuple[bool, tuple[int, int]]:
    line_updates: list[Line] = []
    seg_updates: list[Segment] = []
    for line in _ordered_lines(page):
        if line.type == LineTypeChoices.SURA_HEADER and aya != 1:
            sura += 1
            aya = 1
        if line.sura_id != sura:
            line.sura_id = sura
            line_updates.append(line)
        if line.type == LineTypeChoices.TEXT:
            for segment in line.segments.all():
                if segment.aya_number != aya:
                    segment.aya_number = aya
                    seg_updates.append(segment)
                if segment.has_separator:
                    aya += 1
    if line_updates:
        Line.objects.bulk_update(line_updates, ["sura"])
    if seg_updates:
        Segment.objects.bulk_update(seg_updates, ["aya_number"])
    return bool(line_updates or seg_updates), (sura, aya)


def _consecutive(page: Page, delta: int) -> Page | None:
    return Page.objects.filter(
        mushaf_id=page.mushaf_id, page_number=page.page_number + delta
    ).first()

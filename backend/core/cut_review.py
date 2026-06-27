# mypy: disable-error-code="type-var"

"""Line cut review helpers.

This module keeps final PNG cleanup separate from coordinate review:
coordinate overrides are merged into line/segment results, while eraser strokes
only affect the alpha channel when PNGs are exported.
"""

from __future__ import annotations

import copy
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from core.image_utils import make_transparent
from core.review import (
    CORRECTED_RESULTS_JSON,
    PAGES_DIR,
    RESULTS_DIR,
    RESULTS_JSON,
    load_review_results,
    normalize_review_data,
    resolve_page_copy,
)

SCHEMA_VERSION = 1
CUT_EDITS_JSON = Path("line_cut_edits.json")
LINE_CUT_RESULTS_JSON = Path("line_cut_results.json")
FINAL_LINES_DIR = RESULTS_DIR / "final_lines"


def cut_review_status() -> dict[str, Any]:
    """Return availability information for the line cut review UI."""
    page_count = 0
    if PAGES_DIR.exists():
        page_count = sum(1 for path in PAGES_DIR.iterdir() if path.is_file())
    source_path = _latest_source_path()
    return {
        "cut_review_available": source_path is not None and page_count > 0,
        "source_results": str(source_path) if source_path else None,
        "original_results": RESULTS_JSON.exists(),
        "corrected_results": CORRECTED_RESULTS_JSON.exists(),
        "cut_edits": CUT_EDITS_JSON.exists(),
        "line_cut_results": LINE_CUT_RESULTS_JSON.exists(),
        "final_lines_dir": str(FINAL_LINES_DIR),
        "pages_dir": str(PAGES_DIR),
        "page_count": page_count,
    }


def load_cut_review_results() -> dict[str, Any]:
    """Load source coordinates, cut edits, and merged final coordinates."""
    source_data, source_path = load_review_results("latest")
    edits = load_cut_edits(source_path)
    merged = apply_cut_edits(source_data, edits)
    return {
        "source_path": str(source_path),
        "edits_path": str(CUT_EDITS_JSON),
        "final_results_path": str(LINE_CUT_RESULTS_JSON),
        "source_data": source_data,
        "data": merged,
        "edits": edits,
    }


def load_cut_edits(source_path: Path | None = None) -> dict[str, Any]:
    """Load cut edit JSON, or return an empty edit document."""
    if CUT_EDITS_JSON.exists():
        with open(CUT_EDITS_JSON, encoding="utf-8") as f:
            raw = json.load(f)
    else:
        raw = {}
    return normalize_cut_edits(raw, source_path)


def save_cut_edits(data: dict[str, Any]) -> dict[str, Any]:
    """Normalize cut edits, save them, and write merged final coordinates."""
    source_data, source_path = load_review_results("latest")
    edits = normalize_cut_edits(data, source_path)
    _write_json(CUT_EDITS_JSON, edits)

    merged = apply_cut_edits(source_data, edits)
    _write_json(LINE_CUT_RESULTS_JSON, merged)
    return {
        "status": "saved",
        "source_path": str(source_path),
        "edits_path": str(CUT_EDITS_JSON),
        "final_results_path": str(LINE_CUT_RESULTS_JSON),
        "source_data": source_data,
        "data": merged,
        "edits": edits,
    }


def export_final_line_images(
    output_dir: Path = FINAL_LINES_DIR,
) -> dict[str, Any]:
    """Export final transparent line PNGs from latest coordinates plus cut edits."""
    source_data, source_path = load_review_results("latest")
    edits = load_cut_edits(source_path)
    merged = apply_cut_edits(source_data, edits)
    _write_json(LINE_CUT_RESULTS_JSON, merged)

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []
    for page in _list_value(merged.get("pages")):
        page_image_filename = str(page.get("page_image_filename") or "")
        page_path = resolve_page_copy(page_image_filename, PAGES_DIR)
        image = Image.open(page_path)
        image.load()
        page_edit = _page_edit_for(edits, page)

        for line in _list_value(page.get("lines")):
            line_edit = _line_edit_for(page_edit, line)
            output_path = output_dir / _line_output_name(page, line)
            saved.append(_save_line_crop(image, line, line_edit, output_path))

    return {
        "status": "exported",
        "source_path": str(source_path),
        "edits_path": str(CUT_EDITS_JSON),
        "final_results_path": str(LINE_CUT_RESULTS_JSON),
        "exported_images": len(saved),
        "output_dir": str(output_dir),
        "files": saved,
    }


def normalize_cut_edits(
    data: dict[str, Any],
    source_path: Path | None = None,
) -> dict[str, Any]:
    """Return a sanitized cut-edit document."""
    now = _now()
    created_at = data.get("created_at") if isinstance(data, dict) else None
    normalized: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "created_at": created_at if isinstance(created_at, str) else now,
        "updated_at": now,
        "source": {
            "coordinates_file": str(source_path or _latest_source_path() or RESULTS_JSON),
            "pages_dir": str(PAGES_DIR),
        },
        "pages": [],
    }

    if not isinstance(data, dict):
        return normalized

    for raw_page in _list_value(data.get("pages")):
        page = _normalize_page_edit(raw_page)
        if page["lines"]:
            normalized["pages"].append(page)

    return normalized


def apply_cut_edits(
    source_data: dict[str, Any],
    edits: dict[str, Any],
) -> dict[str, Any]:
    """Apply line bbox overrides and regenerate dependent segment coordinates."""
    merged = copy.deepcopy(source_data)
    for page in _list_value(merged.get("pages")):
        page_edit = _page_edit_for(edits, page)
        if not page_edit:
            continue
        edits_by_line = {
            _positive_int(line_edit.get("line_number"), "line_number"): line_edit
            for line_edit in _list_value(page_edit.get("lines"))
        }
        for line in _list_value(page.get("lines")):
            line_number = _positive_int(line.get("line_number"), "line_number")
            line_edit = edits_by_line.get(line_number)
            bbox_override = line_edit.get("bbox_override") if line_edit else None
            if isinstance(bbox_override, dict):
                line["line_bbox"] = _bbox_value(bbox_override, "bbox_override")

    final_data = normalize_review_data(merged)
    final_data["line_cut_edits_applied_at"] = _now()
    return final_data


def _normalize_page_edit(raw_page: dict[str, Any]) -> dict[str, Any]:
    page: dict[str, Any] = {
        "page_number": _optional_positive_int(raw_page.get("page_number")),
        "image_filename": _optional_string(raw_page.get("image_filename")),
        "page_image_filename": _optional_string(raw_page.get("page_image_filename")),
        "lines": [],
    }
    for raw_line in _list_value(raw_page.get("lines")):
        line = _normalize_line_edit(raw_line)
        if line.get("bbox_override") or line.get("erase_strokes"):
            page["lines"].append(line)
    return page


def _normalize_line_edit(raw_line: dict[str, Any]) -> dict[str, Any]:
    line: dict[str, Any] = {
        "line_number": _positive_int(raw_line.get("line_number"), "line_number"),
    }
    bbox = raw_line.get("bbox_override")
    if isinstance(bbox, dict):
        line["bbox_override"] = _bbox_value(bbox, "bbox_override")

    strokes = []
    for raw_stroke in _list_value(raw_line.get("erase_strokes")):
        stroke = _normalize_stroke(raw_stroke)
        if stroke["points"]:
            strokes.append(stroke)
    if strokes:
        line["erase_strokes"] = strokes
    return line


def _normalize_stroke(raw_stroke: dict[str, Any]) -> dict[str, Any]:
    stroke_id = raw_stroke.get("id")
    stroke: dict[str, Any] = {
        "id": stroke_id if isinstance(stroke_id, str) and stroke_id else _now(),
        "brush_size": _positive_int(raw_stroke.get("brush_size", 12), "brush_size"),
        "points": [],
    }
    for point in raw_stroke.get("points") or []:
        if not isinstance(point, list | tuple) or len(point) < 2:
            continue
        x = _non_negative_int(point[0], "point.x")
        y = _non_negative_int(point[1], "point.y")
        stroke["points"].append([x, y])
    return stroke


def _save_line_crop(
    image: Image.Image,
    line: dict[str, Any],
    line_edit: dict[str, Any] | None,
    output_path: Path,
) -> str:
    box = _bbox_value(line.get("line_bbox"), "line_bbox")
    left = min(max(0, box["x"]), image.width - 1)
    top = min(max(0, box["y"]), image.height - 1)
    right = min(image.width, max(left + 1, box["x"] + box["w"]))
    bottom = min(image.height, max(top + 1, box["y"] + box["h"]))
    crop = image.crop((left, top, right, bottom))
    rgba = make_transparent(crop)

    strokes = _list_value((line_edit or {}).get("erase_strokes"))
    if strokes:
        alpha = rgba.getchannel("A")
        draw = ImageDraw.Draw(alpha)
        for stroke in strokes:
            _apply_eraser_stroke(draw, stroke, left, top)
        rgba.putalpha(alpha)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(output_path)
    return str(output_path)


def _apply_eraser_stroke(
    draw: ImageDraw.ImageDraw,
    stroke: dict[str, Any],
    offset_x: int,
    offset_y: int,
) -> None:
    brush_size = _positive_int(stroke.get("brush_size", 12), "brush_size")
    radius = max(1, brush_size // 2)
    points = [
        (int(point[0]) - offset_x, int(point[1]) - offset_y)
        for point in stroke.get("points", [])
        if isinstance(point, list) and len(point) >= 2
    ]
    if not points:
        return
    if len(points) > 1:
        draw.line(points, fill=0, width=brush_size, joint="curve")
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=0)


def _page_edit_for(
    edits: dict[str, Any],
    page: dict[str, Any],
) -> dict[str, Any] | None:
    page_number = _optional_positive_int(page.get("page_number"))
    page_image_filename = str(page.get("page_image_filename") or "")
    for page_edit in _list_value(edits.get("pages")):
        if page_image_filename and page_edit.get("page_image_filename") == page_image_filename:
            return page_edit
        if page_number and page_edit.get("page_number") == page_number:
            return page_edit
    return None


def _line_edit_for(
    page_edit: dict[str, Any] | None,
    line: dict[str, Any],
) -> dict[str, Any] | None:
    if not page_edit:
        return None
    line_number = _positive_int(line.get("line_number"), "line_number")
    for line_edit in _list_value(page_edit.get("lines")):
        if line_edit.get("line_number") == line_number:
            return line_edit
    return None


def _line_output_name(page: dict[str, Any], line: dict[str, Any]) -> str:
    stem = Path(str(page.get("image_filename") or page.get("page_image_filename"))).stem
    line_number = _positive_int(line.get("line_number"), "line_number")
    line_type = str(line.get("type") or "text")
    if line_type == "sura_header":
        sura = _optional_positive_int(line.get("sura_number"))
        return f"{stem}-l{line_number:02d}-sura{sura or 0:03d}-header.png"
    if line_type == "basmala":
        sura = _optional_positive_int(line.get("sura_number"))
        return f"{stem}-l{line_number:02d}-sura{sura or 0:03d}-basmala.png"
    return f"{stem}-l{line_number:02d}{_text_line_suffix(line)}.png"


def _text_line_suffix(line: dict[str, Any]) -> str:
    segments = _list_value(line.get("segments"))
    suras = [
        _optional_positive_int(segment.get("sura_number"))
        for segment in segments
        if _optional_positive_int(segment.get("sura_number"))
    ]
    ayas = [
        _optional_positive_int(segment.get("aya_number"))
        for segment in segments
        if _optional_positive_int(segment.get("aya_number"))
    ]
    if not suras or not ayas:
        return "-text"
    if min(suras) == max(suras):
        if min(ayas) == max(ayas):
            return f"-sura{suras[0]:03d}-aya{ayas[0]:03d}"
        return f"-sura{suras[0]:03d}-aya{min(ayas):03d}-{max(ayas):03d}"
    return f"-sura{min(suras):03d}-{max(suras):03d}-aya{min(ayas):03d}-{max(ayas):03d}"


def _latest_source_path() -> Path | None:
    if CORRECTED_RESULTS_JSON.exists():
        return CORRECTED_RESULTS_JSON
    if RESULTS_JSON.exists():
        return RESULTS_JSON
    return None


def _write_json(path: Path, data: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _bbox_value(value: Any, name: str) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return {
        "x": _non_negative_int(value.get("x"), f"{name}.x"),
        "y": _non_negative_int(value.get("y"), f"{name}.y"),
        "w": _positive_int(value.get("w"), f"{name}.w"),
        "h": _positive_int(value.get("h"), f"{name}.h"),
    }


def _list_value(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _optional_positive_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return _positive_int(value, "value")


def _positive_int(value: Any, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if result < 1:
        raise ValueError(f"{name} must be positive")
    return result


def _non_negative_int(value: Any, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if result < 0:
        raise ValueError(f"{name} must be non-negative")
    return result


def _now() -> str:
    return datetime.now(UTC).isoformat()

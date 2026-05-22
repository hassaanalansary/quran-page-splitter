"""Review-mode helpers for corrected coordinate data and image re-export."""

from __future__ import annotations

import copy
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image

from core.quran_metadata import get_sura
from image_utils import make_transparent

RESULTS_JSON = Path("results.json")
CORRECTED_RESULTS_JSON = Path("corrected_results.json")
RESULTS_DIR = Path("results")
PAGES_DIR = RESULTS_DIR / "pages"
CORRECTED_IMAGES_DIR = RESULTS_DIR / "corrected_images"


def safe_page_image_filename(page_number: int, original_name: str | None) -> str:
    """Return a stable, traversal-safe filename for a saved source page."""
    raw = original_name or "page.png"
    leaf = raw.replace("\\", "/").split("/")[-1].strip() or "page.png"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", leaf).strip("._")
    if not safe:
        safe = "page.png"
    return f"{page_number:04d}_{safe}"


def save_page_copy(
    raw_bytes: bytes,
    original_name: str | None,
    page_number: int,
    pages_dir: Path = PAGES_DIR,
) -> str:
    """Save the uploaded page bytes for review and return its safe filename."""
    pages_dir.mkdir(parents=True, exist_ok=True)
    page_filename = safe_page_image_filename(page_number, original_name)
    (pages_dir / page_filename).write_bytes(raw_bytes)
    return page_filename


def resolve_page_copy(filename: str, pages_dir: Path = PAGES_DIR) -> Path:
    """Resolve a review page filename without allowing path traversal."""
    if Path(filename).name != filename:
        raise ValueError("Invalid page filename")

    root = pages_dir.resolve()
    path = (pages_dir / filename).resolve()
    if path.parent != root:
        raise ValueError("Invalid page filename")
    if not path.exists():
        raise FileNotFoundError(filename)
    return path


def normalize_review_data(data: dict[str, Any]) -> dict[str, Any]:
    """Regenerate segments and Quran numbering for edited review data."""
    corrected: dict[str, Any] = copy.deepcopy(data)
    pages = _list_value(corrected.get("pages"))
    current_sura = _positive_int(corrected.get("start_sura"), "start_sura")
    current_aya = _positive_int(corrected.get("start_aya"), "start_aya")

    for page in pages:
        lines = _list_value(page.get("lines"))
        for line_number, line in enumerate(lines, start=1):
            line["line_number"] = line_number
            line_type = line.get("type", "text")

            if line_type == "sura_header":
                manual_sura = _optional_positive_int(line.get("manual_sura_anchor"))
                if manual_sura is not None:
                    current_sura = manual_sura
                    current_aya = 1
                elif current_aya != 1:
                    current_sura += 1
                    current_aya = 1

                sura_info = get_sura(current_sura)
                line["sura_number"] = current_sura
                line["sura_name"] = sura_info.name
                line["sura_transliteration"] = sura_info.transliteration
                line.pop("segments", None)
                line.pop("separator_cuts", None)
                continue

            if line_type == "basmala":
                sura_info = get_sura(current_sura)
                line["sura_number"] = current_sura
                line["sura_name"] = sura_info.name
                line.pop("segments", None)
                line.pop("separator_cuts", None)
                continue

            line["type"] = "text"
            _regenerate_text_segments(line)
            for segment in _list_value(line.get("segments")):
                manual_aya = _optional_positive_int(segment.get("manual_aya_anchor"))
                if manual_aya is not None:
                    current_aya = manual_aya

                sura_info = get_sura(current_sura)
                segment["sura_number"] = current_sura
                segment["sura_name"] = sura_info.name
                segment["aya_number"] = current_aya

                if bool(segment.get("has_separator")):
                    segment["is_continuation"] = False
                    current_aya += 1
                else:
                    segment["is_continuation"] = True

    corrected["pages_processed"] = len(pages)
    corrected["end_sura"] = current_sura
    corrected["end_aya"] = current_aya
    corrected["corrected_at"] = datetime.now(UTC).isoformat()
    return corrected


def save_corrected_results(
    data: dict[str, Any],
    output_path: Path = CORRECTED_RESULTS_JSON,
) -> dict[str, Any]:
    """Normalize and write corrected review data."""
    corrected = normalize_review_data(data)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(corrected, f, ensure_ascii=False, indent=2)
    return corrected


def load_review_results(source: str = "latest") -> tuple[dict[str, Any], Path]:
    """Load original or latest corrected review data."""
    if source == "original":
        path = RESULTS_JSON
    elif source == "latest":
        path = (
            CORRECTED_RESULTS_JSON
            if CORRECTED_RESULTS_JSON.exists()
            else RESULTS_JSON
        )
    else:
        raise ValueError("source must be 'latest' or 'original'")

    with open(path, encoding="utf-8") as f:
        return json.load(f), path


def re_export_corrected_images(
    results_path: Path = CORRECTED_RESULTS_JSON,
    pages_dir: Path = PAGES_DIR,
    output_dir: Path = CORRECTED_IMAGES_DIR,
) -> dict[str, Any]:
    """Re-export corrected crops from saved source pages."""
    with open(results_path, encoding="utf-8") as f:
        data = json.load(f)
    corrected = normalize_review_data(data)

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []
    for page in _list_value(corrected.get("pages")):
        page_image_filename = str(page.get("page_image_filename") or "")
        page_path = resolve_page_copy(page_image_filename, pages_dir)
        image = Image.open(page_path)
        image.load()
        stem = Path(str(page.get("image_filename") or page_image_filename)).stem

        for line in _list_value(page.get("lines")):
            line_type = line.get("type")
            line_number = _positive_int(line.get("line_number"), "line_number")
            if line_type == "sura_header":
                sura_number = _positive_int(line.get("sura_number"), "sura_number")
                name = (
                    f"{stem}-l{line_number:02d}"
                    f"-sura{sura_number:03d}-header.png"
                )
                saved.append(_save_crop(image, line["line_bbox"], output_dir / name))
                continue

            if line_type == "basmala":
                sura_number = _positive_int(line.get("sura_number"), "sura_number")
                name = (
                    f"{stem}-l{line_number:02d}"
                    f"-sura{sura_number:03d}-basmala.png"
                )
                saved.append(_save_crop(image, line["line_bbox"], output_dir / name))
                continue

            segments = _list_value(line.get("segments"))
            for segment_index, segment in enumerate(segments, start=1):
                sura_part = (
                    f"-sura{int(segment['sura_number']):03d}"
                    if segment.get("sura_number")
                    else ""
                )
                aya_part = (
                    f"-aya{int(segment['aya_number']):03d}"
                    if segment.get("aya_number")
                    else ""
                )
                if len(segments) == 1:
                    name = f"{stem}-l{line_number:02d}{sura_part}{aya_part}.png"
                else:
                    name = (
                        f"{stem}-l{line_number:02d}-s{segment_index:02d}"
                        f"{sura_part}{aya_part}.png"
                    )
                saved.append(_save_crop(image, segment["bbox"], output_dir / name))

    return {
        "exported_images": len(saved),
        "output_dir": str(output_dir),
        "files": saved,
    }


def review_status() -> dict[str, Any]:
    """Return availability information for the review UI."""
    page_count = 0
    if PAGES_DIR.exists():
        page_count = sum(1 for path in PAGES_DIR.iterdir() if path.is_file())
    return {
        "review_available": RESULTS_JSON.exists() and page_count > 0,
        "original_results": RESULTS_JSON.exists(),
        "corrected_results": CORRECTED_RESULTS_JSON.exists(),
        "pages_dir": str(PAGES_DIR),
        "page_count": page_count,
    }


def _regenerate_text_segments(line: dict[str, Any]) -> None:
    bbox = _bbox_value(line.get("line_bbox"), "line_bbox")
    old_segments = _list_value(line.get("segments"))
    cuts = _separator_cuts(line, bbox)
    line["separator_cuts"] = cuts

    segments: list[dict[str, Any]] = []
    end = bbox["x"] + bbox["w"]
    for cut in reversed(cuts):
        segment = {
            "has_separator": True,
            "bbox": {
                "x": cut,
                "y": bbox["y"],
                "w": end - cut,
                "h": bbox["h"],
            },
        }
        segments.append(segment)
        end = cut

    left_width = end - bbox["x"]
    if left_width > 0 or not segments:
        segments.append(
            {
                "has_separator": False,
                "bbox": {
                    "x": bbox["x"],
                    "y": bbox["y"],
                    "w": max(1, left_width),
                    "h": bbox["h"],
                },
            }
        )

    for index, old_segment in enumerate(old_segments):
        if index >= len(segments):
            break
        if "manual_aya_anchor" in old_segment:
            segments[index]["manual_aya_anchor"] = old_segment["manual_aya_anchor"]

    line["segments"] = segments


def _separator_cuts(line: dict[str, Any], bbox: dict[str, int]) -> list[int]:
    raw_cuts = line.get("separator_cuts")
    if not isinstance(raw_cuts, list):
        raw_cuts = [
            _bbox_value(segment.get("bbox"), "segment.bbox")["x"]
            for segment in _list_value(line.get("segments"))
            if bool(segment.get("has_separator"))
        ]

    left = bbox["x"]
    right = bbox["x"] + bbox["w"]
    cuts: set[int] = set()
    for value in raw_cuts:
        cut = _positive_int(value, "separator_cuts")
        if left < cut < right:
            cuts.add(cut)
    return sorted(cuts)


def _save_crop(image: Image.Image, bbox: Any, output_path: Path) -> str:
    box = _bbox_value(bbox, "bbox")
    crop = image.crop(
        (
            box["x"],
            box["y"],
            box["x"] + box["w"],
            box["y"] + box["h"],
        )
    )
    make_transparent(crop).save(output_path)
    return str(output_path)


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


def _optional_positive_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return _positive_int(value, "manual anchor")


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

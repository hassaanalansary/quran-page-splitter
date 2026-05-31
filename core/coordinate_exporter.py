"""Sura/aya position tracking and coordinate export helpers.

Provides track_positions() which walks a processed PageContext and
updates the QuranTracker state, populating sura/aya numbers on every
line and segment. Also provides logging setup and JSON save utilities.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from core.context import BBox, LineResult, PageContext, QuranTracker
from core.quran_metadata import get_aya_count, get_sura
from image_utils import find_content_bbox

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Position tracking
# ------------------------------------------------------------------


def track_positions(ctx: PageContext, tracker: QuranTracker) -> None:
    """Walk ctx.lines and their segments, update tracker, populate sura/aya numbers.

    Must be called AFTER detection, classification, and segment splitting
    have all populated the PageContext.
    """
    for line in ctx.lines:
        if line.is_sura:
            _handle_sura_header(line, tracker)
            content_bbox = find_content_bbox(
                ctx.binary[
                    line.bbox.top : line.bbox.bottom, line.bbox.left : line.bbox.right
                ]
            )
            if content_bbox is None:
                continue
            x, y, w, h = content_bbox
            line.bbox = BBox(
                left=line.bbox.left + x,
                top=line.bbox.top + y,
                right=line.bbox.left + x + w,
                bottom=line.bbox.top + y + h,
            )
            continue

        if tracker.pending_basmala:
            tracker.pending_basmala = False
            has_any_separator = any(seg.has_separator for seg in line.segments)

            if not has_any_separator:
                _handle_basmala(line, tracker)
                content_bbox = find_content_bbox(
                    ctx.binary[
                        line.bbox.top : line.bbox.bottom,
                        line.bbox.left : line.bbox.right,
                    ]
                )
                if content_bbox is None:
                    continue
                x, y, w, h = content_bbox
                line.bbox = BBox(
                    left=line.bbox.left + x,
                    top=line.bbox.top + y,
                    right=line.bbox.left + x + w,
                    bottom=line.bbox.top + y + h,
                )
                continue

            # Has separator → not a basmala, treat as normal text
            logger.info(
                "  Line %d: first line after sura header has separator "
                "→ treating as normal text (no basmala)",
                line.line_index,
            )

        _handle_text_line(line, tracker)


def _handle_sura_header(line: LineResult, tracker: QuranTracker) -> None:
    """Advance on true sura transitions; populate line fields.

    At batch start ``start_aya == 1``, the first ornamental line marks the **current**
    sura, not the next — ``advance_sura()`` must be skipped then. Mid-run, completing a
    sura pushes ``current_aya`` past 1 before the next header, so we still advance.
    """
    if tracker.current_aya != 1:
        tracker.advance_sura()
    else:
        tracker.pending_basmala = True
    sura_info = get_sura(tracker.current_sura)

    line.sura_number = tracker.current_sura
    line.sura_name = sura_info.name
    line.sura_transliteration = sura_info.transliteration

    logger.info(
        "  Line %d: 📖 SURA HEADER — Starting Sura #%d: %s (%s)",
        line.line_index,
        tracker.current_sura,
        sura_info.name,
        sura_info.transliteration,
    )
    logger.info("    Total ayas in this sura: %d", sura_info.aya_count)


def _handle_basmala(line: LineResult, tracker: QuranTracker) -> None:
    """Process a basmala line (first line after sura header with no separator)."""
    line.is_basmala = True
    line.sura_number = tracker.current_sura
    sura_info = get_sura(tracker.current_sura)
    line.sura_name = sura_info.name

    logger.info(
        "  Line %d: ﷽  BASMALA — Sura #%d (%s)",
        line.line_index,
        tracker.current_sura,
        sura_info.name,
    )


def _handle_text_line(line: LineResult, tracker: QuranTracker) -> None:
    """Process a normal text line: assign sura/aya to each segment."""
    sep_count = sum(1 for s in line.segments if s.has_separator)
    logger.info(
        "  Line %d: TEXT — %d segment(s), %d separator(s)",
        line.line_index,
        len(line.segments),
        sep_count,
    )

    for seg in line.segments:
        seg.sura_number = tracker.current_sura
        seg.aya_number = tracker.current_aya

        sura_info = get_sura(tracker.current_sura)
        seg_bbox = seg.bbox

        if seg.has_separator:
            # This segment COMPLETES the current aya
            seg.is_continuation = False

            expected_max = get_aya_count(tracker.current_sura)
            if tracker.current_aya > expected_max:
                logger.warning(
                    "    ⚠ Aya %d exceeds expected max (%d) for Sura #%d (%s)!",
                    tracker.current_aya,
                    expected_max,
                    tracker.current_sura,
                    sura_info.name,
                )

            logger.info(
                "    ✦ Aya %d of %s (Sura #%d) — bbox: (%d, %d, %d, %d)",
                tracker.current_aya,
                sura_info.name,
                tracker.current_sura,
                seg_bbox.left,
                seg_bbox.top,
                seg_bbox.width,
                seg_bbox.height,
            )

            tracker.advance_aya()
        else:
            # Continuation of the current aya (no separator)
            seg.is_continuation = True

            logger.info(
                "    … Aya %d of %s (Sura #%d) [continued] — bbox: (%d, %d, %d, %d)",
                tracker.current_aya,
                sura_info.name,
                tracker.current_sura,
                seg_bbox.left,
                seg_bbox.top,
                seg_bbox.width,
                seg_bbox.height,
            )


# ------------------------------------------------------------------
# Coordinate collection
# ------------------------------------------------------------------


def collect_page_coordinates(ctx: PageContext) -> dict:
    """Build a JSON-serializable dict of coordinates for a single page."""
    page_data: dict = {
        "page_number": ctx.page_index,
        "image_filename": ctx.filename,
        "page_image_filename": ctx.page_image_filename,
        "crop_box": ctx.crop_box.as_xywh() if ctx.crop_box else None,
        "lines": [],
    }

    for line in ctx.lines:
        line_bbox = _export_line_bbox(line)
        line_data: dict = {
            "line_number": line.line_index,
            "slot_count": line.slot_count,
            "line_bbox": line_bbox.as_xywh(),
        }

        if line.is_sura:
            line_data["type"] = "sura_header"
            line_data["sura_number"] = line.sura_number
            line_data["sura_name"] = line.sura_name
            line_data["sura_transliteration"] = line.sura_transliteration
        elif line.is_basmala:
            line_data["type"] = "basmala"
            line_data["sura_number"] = line.sura_number
            line_data["sura_name"] = line.sura_name
        else:
            line_data["type"] = "text"
            line_data["separator_cuts"] = sorted(
                seg.bbox.left for seg in line.segments if seg.has_separator
            )
            line_data["segments"] = []
            for seg in line.segments:
                line_data["segments"].append(
                    {
                        "sura_number": seg.sura_number,
                        "sura_name": get_sura(seg.sura_number).name
                        if seg.sura_number
                        else None,
                        "aya_number": seg.aya_number,
                        "is_continuation": seg.is_continuation,
                        "has_separator": seg.has_separator,
                        "bbox": seg.bbox.as_xywh(),
                    }
                )

        page_data["lines"].append(line_data)

    return page_data


def _export_line_bbox(line: LineResult) -> BBox:
    """Use segment extents for text lines so review bounds avoid empty margins."""
    if line.is_sura or line.is_basmala or not line.segments:
        return line.bbox

    return BBox(
        left=min(seg.bbox.left for seg in line.segments),
        top=min(seg.bbox.top for seg in line.segments),
        right=max(seg.bbox.right for seg in line.segments),
        bottom=max(seg.bbox.bottom for seg in line.segments),
    )


# ------------------------------------------------------------------
# Logging setup
# ------------------------------------------------------------------


def setup_export_logging(log_path: Path) -> None:
    """Configure the module logger to write detailed output to a file.

    All messages at DEBUG level and above are written to the log file.
    A summary stream is also printed to the console at INFO level.
    """
    export_logger = logging.getLogger(__name__)
    export_logger.setLevel(logging.DEBUG)

    # Remove existing handlers (avoid duplicate output on re-runs)
    export_logger.handlers.clear()

    # File handler — detailed log
    file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_fmt = logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s")
    file_handler.setFormatter(file_fmt)
    export_logger.addHandler(file_handler)

    # Console handler — summary only
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_fmt = logging.Formatter("%(message)s")
    console_handler.setFormatter(console_fmt)
    export_logger.addHandler(console_handler)

    # Prevent propagation to root logger
    export_logger.propagate = False


def save_json(data: dict, output_path: Path) -> None:
    """Save coordinate data as formatted JSON with UTF-8 encoding."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info("JSON saved to %s", output_path)

"""Coordinate exporter: processes a full mushaf and outputs aya coordinates as JSON.

Processes pages sequentially, tracking sura/aya state across pages.
Logs everything in detail to a file for traceability.
"""

from __future__ import annotations

import io
import json
import logging
import statistics
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from core.aya_separator import AyaSeparatorProcessor, SegmentResult
from core.classifier import SuraClassifier
from core.line_detector import DetectedLine, LineDetector
from core.quran_metadata import get_aya_count, get_sura

logger = logging.getLogger("coordinate_export")


class CoordinateExporter:
    """Processes mushaf pages and exports aya bounding-box coordinates.

    Coordinates are in original page image pixel space (before any cropping).
    """

    def __init__(
        self,
        detector: LineDetector,
        classifier: SuraClassifier,
        aya_separator: AyaSeparatorProcessor,
        start_sura: int,
        start_aya: int,
    ):
        self.detector = detector
        self.classifier = classifier
        self.aya_separator = aya_separator

        # Mutable state — tracks position in the Quran
        self.current_sura = start_sura
        self.current_aya = start_aya
        self._pending_basmala_check = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def export(
        self,
        pages_dir: Path,
        start_page: int = 3,
    ) -> dict:
        """Process all page images in ``pages_dir`` and return coordinate data.

        Pages are sorted by filename. Only pages whose number (extracted
        from the filename) is ≥ ``start_page`` are processed.
        """
        image_files = sorted(
            p
            for p in pages_dir.iterdir()
            if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"}
        )

        if not image_files:
            logger.error("No image files found in %s", pages_dir)
            return {"pages": []}

        logger.info("=" * 60)
        logger.info("COORDINATE EXPORT STARTED")
        logger.info(
            "Starting from Sura #%d (%s), Aya %d",
            self.current_sura,
            get_sura(self.current_sura)["name"],
            self.current_aya,
        )
        logger.info("Processing pages >= %d from %s", start_page, pages_dir)
        logger.info("Found %d image files total", len(image_files))
        logger.info("=" * 60)

        result: dict = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "start_sura": self.current_sura,
            "start_aya": self.current_aya,
            "start_page": start_page,
            "pages": [],
        }

        pages_processed = 0
        for page_index, img_path in enumerate(image_files):
            page_number = self._extract_page_number(img_path)
            if page_number < start_page:
                logger.debug("Skipping page %d (%s)", page_number, img_path.name)
                continue

            page_data = self._process_page(img_path, page_number, page_index)
            result["pages"].append(page_data)
            pages_processed += 1

        # Summary
        sura_info = get_sura(self.current_sura)
        logger.info("=" * 60)
        logger.info("EXPORT COMPLETE")
        logger.info("Pages processed: %d", pages_processed)
        logger.info(
            "Ended at Sura #%d (%s), Aya %d",
            self.current_sura,
            sura_info["name"],
            self.current_aya,
        )
        logger.info("=" * 60)

        result["end_sura"] = self.current_sura
        result["end_aya"] = self.current_aya
        result["pages_processed"] = pages_processed
        return result

    # ------------------------------------------------------------------
    # Page Processing
    # ------------------------------------------------------------------

    def _process_page(
        self,
        img_path: Path,
        page_number: int,
        page_index: int,
    ) -> dict:
        logger.info("")
        logger.info("━" * 50)
        logger.info("📄 PAGE %d — %s", page_number, img_path.name)
        logger.info("━" * 50)

        img = Image.open(img_path)
        img.load()

        # Detect lines with coordinates
        try:
            detected_lines = self.detector.detect_with_coords(
                img, page_index=page_index
            )
        except Exception as e:
            logger.error("  ❌ Detection failed: %s", e)
            return {
                "page_number": page_number,
                "image_filename": img_path.name,
                "error": str(e),
                "lines": [],
            }

        if not detected_lines:
            logger.warning("  ⚠ No lines detected on page %d", page_number)
            return {
                "page_number": page_number,
                "image_filename": img_path.name,
                "lines": [],
            }

        logger.info("  Detected %d lines", len(detected_lines))

        # Pre-compute median height for sura classification
        median_h = statistics.median(line.image.height for line in detected_lines)
        total_lines = len(detected_lines)

        page_data: dict = {
            "page_number": page_number,
            "image_filename": img_path.name,
            "lines": [],
        }

        for line_idx, line in enumerate(detected_lines, start=1):
            line_data = self._process_line(
                line, line_idx, median_h, total_lines
            )
            page_data["lines"].append(line_data)

        return page_data

    # ------------------------------------------------------------------
    # Line Processing
    # ------------------------------------------------------------------

    def _process_line(
        self,
        line: DetectedLine,
        line_idx: int,
        median_h: float,
        total_lines: int,
    ) -> dict:
        line_bbox = self._bbox_to_xywh(line.bbox)

        # Classify: is this a sura header?
        is_sura = self.classifier.classify_single(line.image, idx=line_idx)

        if is_sura:
            return self._handle_sura_header(line, line_idx, line_bbox)

        # Check for basmala (line immediately after sura header)
        if self._pending_basmala_check:
            self._pending_basmala_check = False
            segments = self.aya_separator.split_line_with_coords(line.image)
            has_any_separator = any(seg.has_separator for seg in segments)

            if not has_any_separator:
                return self._handle_basmala(line, line_idx, line_bbox)

            # Has separator → treat as normal text line
            logger.info(
                "  Line %d: first line after sura header has separator "
                "→ treating as normal text (no basmala)",
                line_idx,
            )
            return self._handle_text_line(
                line, line_idx, line_bbox, segments=segments
            )

        # Normal text line
        return self._handle_text_line(line, line_idx, line_bbox)

    def _handle_sura_header(
        self, line: DetectedLine, line_idx: int, line_bbox: dict
    ) -> dict:
        self.current_sura += 1
        self.current_aya = 0
        self._pending_basmala_check = True

        sura_info = get_sura(self.current_sura)
        logger.info(
            "  Line %d: 📖 SURA HEADER — Starting Sura #%d: %s (%s)",
            line_idx,
            self.current_sura,
            sura_info["name"],
            sura_info["transliteration"],
        )
        logger.info(
            "    Total ayas in this sura: %d",
            sura_info["aya_count"],
        )

        return {
            "line_number": line_idx,
            "line_bbox": line_bbox,
            "type": "sura_header",
            "sura_number": self.current_sura,
            "sura_name": sura_info["name"],
            "sura_transliteration": sura_info["transliteration"],
        }

    def _handle_basmala(
        self, line: DetectedLine, line_idx: int, line_bbox: dict
    ) -> dict:
        sura_info = get_sura(self.current_sura)
        logger.info(
            "  Line %d: ﷽  BASMALA — Sura #%d (%s)",
            line_idx,
            self.current_sura,
            sura_info["name"],
        )

        return {
            "line_number": line_idx,
            "line_bbox": line_bbox,
            "type": "basmala",
            "sura_number": self.current_sura,
            "sura_name": sura_info["name"],
        }

    def _handle_text_line(
        self,
        line: DetectedLine,
        line_idx: int,
        line_bbox: dict,
        segments: list[SegmentResult] | None = None,
    ) -> dict:
        if segments is None:
            segments = self.aya_separator.split_line_with_coords(line.image)

        sep_count = sum(1 for s in segments if s.has_separator)
        logger.info(
            "  Line %d: TEXT — %d segment(s), %d separator(s)",
            line_idx,
            len(segments),
            sep_count,
        )

        line_data: dict = {
            "line_number": line_idx,
            "line_bbox": line_bbox,
            "type": "text",
            "segments": [],
        }

        for seg in segments:
            seg_data = self._process_segment(seg, line, line_idx)
            line_data["segments"].append(seg_data)

        return line_data

    # ------------------------------------------------------------------
    # Segment Processing
    # ------------------------------------------------------------------

    def _process_segment(
        self,
        seg: SegmentResult,
        line: DetectedLine,
        line_idx: int,
    ) -> dict:
        if seg.has_separator:
            # This segment COMPLETES the current aya — label first, then advance
            aya_number = self.current_aya
            self.current_aya += 1

            expected_max = get_aya_count(self.current_sura)
            if aya_number > expected_max:
                logger.warning(
                    "    ⚠ Aya %d exceeds expected max (%d) for Sura #%d (%s)!",
                    aya_number,
                    expected_max,
                    self.current_sura,
                    get_sura(self.current_sura)["name"],
                )
        else:
            # Continuation of whatever aya is currently in progress
            aya_number = self.current_aya

        sura_info = get_sura(self.current_sura)
        seg_bbox = self._segment_to_page_bbox(seg, line)

        if seg.has_separator:
            logger.info(
                "    ✦ Aya %d of %s (Sura #%d) — bbox: (%d, %d, %d, %d)",
                aya_number, sura_info["name"], self.current_sura,
                seg_bbox["x"], seg_bbox["y"], seg_bbox["w"], seg_bbox["h"],
            )
        else:
            logger.info(
                "    … Aya %d of %s (Sura #%d) [continued] — bbox: (%d, %d, %d, %d)",
                aya_number, sura_info["name"], self.current_sura,
                seg_bbox["x"], seg_bbox["y"], seg_bbox["w"], seg_bbox["h"],
            )

        return {
            "sura_number": self.current_sura,
            "sura_name": sura_info["name"],
            "aya_number": aya_number,
            "is_continuation": not seg.has_separator,
            "bbox": seg_bbox,
        }

    # ------------------------------------------------------------------
    # Coordinate Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _bbox_to_xywh(bbox: dict) -> dict:
        """Convert {left, top, right, bottom} to {x, y, w, h}."""
        return {
            "x": bbox["left"],
            "y": bbox["top"],
            "w": bbox["right"] - bbox["left"],
            "h": bbox["bottom"] - bbox["top"],
        }

    @staticmethod
    def _segment_to_page_bbox(seg: SegmentResult, line: DetectedLine) -> dict:
        """Translate segment coords to original page coordinates.

        seg.x_start/x_end are relative to the original line image.
        line.bbox is already in original page coordinates.
        """
        return {
            "x": line.bbox["left"] + seg.x_start,
            "y": line.bbox["top"],
            "w": seg.x_end - seg.x_start,
            "h": line.bbox["bottom"] - line.bbox["top"],
        }

    @staticmethod
    def _extract_page_number(img_path: Path) -> int:
        """Extract page number from filename. Expects digits in the stem."""
        stem = img_path.stem
        digits = "".join(c for c in stem if c.isdigit())
        if not digits:
            raise ValueError(
                f"Cannot extract page number from filename: {img_path.name}"
            )
        return int(digits)


def setup_export_logging(log_path: Path) -> None:
    """Configure the 'coordinate_export' logger to write to a file.

    All messages at DEBUG level and above are written to the log file.
    A summary stream is also printed to the console at INFO level.
    """
    export_logger = logging.getLogger("coordinate_export")
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

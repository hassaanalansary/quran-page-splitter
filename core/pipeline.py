"""Pipeline: iterates over raw image bytes and delegates to PageProcessor.

Creates a QuranTracker that persists across all pages, builds PageContext
for each page, and collects results.
"""

import io
import json
import logging
from datetime import UTC, datetime

from PIL import Image

from core.config import ExportConfig
from core.context import QuranTracker
from core.opencv_accel import configure_opencv_acceleration
from core.page_processor import (
    PageProcessor,
    create_context,
    is_line_geometry_failure,
)
from core.quran_metadata import get_sura

logger = logging.getLogger(__name__)


class Pipeline:
    def __init__(self, processor: PageProcessor, export_config: ExportConfig):
        self.processor = processor
        self.export_config = export_config

    def run(
        self,
        images_data: list[tuple[bytes, str]],
        output_path: str = "results.json",
        log_path: str = "results.log",
    ) -> dict:
        """Process a batch of (raw_bytes, filename) pairs.

        Returns a dict with status, per-page results, and optionally
        coordinate data. Detailed logs are written to ``log_path``.
        """
        # Set up file logging for the entire run
        file_handler = self._setup_file_logging(log_path)

        cfg = self.export_config
        tracker = QuranTracker(
            current_sura=cfg.start_sura,
            current_aya=cfg.start_aya,
        )

        configure_opencv_acceleration()

        logger.info("=" * 60)
        logger.info("PIPELINE STARTED")
        logger.info(
            "Starting from Sura #%d (%s), Aya %d",
            tracker.current_sura,
            get_sura(tracker.current_sura).name,
            tracker.current_aya,
        )
        logger.info("Export images: %s", cfg.export_images)
        logger.info("Export coordinates: %s", cfg.export_coordinates)
        logger.info("Expected lines per page: %d", cfg.expected_lines)
        logger.info("Processing %d page(s)", len(images_data))
        logger.info("=" * 60)

        page_results: list[dict] = []
        coordinate_pages: list[dict] = []
        aborted = False
        abort_detail: dict | None = None

        for page_index, (raw_bytes, filename) in enumerate(images_data, start=1):
            logger.info("Processing %s", filename)
            try:
                img = Image.open(io.BytesIO(raw_bytes))
            except Exception as e:
                logger.error("Failed to open %s: %s", filename, e)
                page_results.append(
                    {"filename": filename, "status": "error", "message": str(e)}
                )
                continue

            ctx = create_context(img, filename, page_index)
            result = self.processor.process(
                ctx,
                tracker,
                export_images=cfg.export_images,
                export_coordinates=cfg.export_coordinates,
                expected_lines=cfg.expected_lines,
            )

            # Extract coordinate data if present
            if "coordinates" in result:
                coordinate_pages.append(result.pop("coordinates"))

            page_results.append(result)

            if is_line_geometry_failure(result.get("status", "")):
                aborted = True
                abort_detail = {
                    "page_index": page_index,
                    "filename": filename,
                    "status": result.get("status"),
                    "expected_lines": result.get("expected_lines"),
                    "detected_lines": result.get("detected_lines"),
                }
                remaining = images_data[page_index:]
                for _, fn in remaining:
                    page_results.append(
                        {
                            "filename": fn,
                            "status": "skipped_batch_abort",
                            "message": "Not processed: batch aborted after line detection failure",
                        }
                    )
                logger.error(
                    "Batch aborted at page %d (%s): %s",
                    page_index,
                    filename,
                    result.get("status"),
                )
                break

        # Summary
        sura_info = get_sura(tracker.current_sura)
        logger.info("=" * 60)
        if aborted:
            logger.info("PIPELINE ABORTED (line detection)")
            logger.info("Pages in result list: %d", len(page_results))
            if abort_detail:
                logger.info(
                    "Failure at page %d — %s (expected %s lines, status=%s)",
                    abort_detail["page_index"],
                    abort_detail["filename"],
                    abort_detail.get("expected_lines"),
                    abort_detail.get("status"),
                )
        else:
            logger.info("PIPELINE COMPLETE")
            logger.info("Pages processed: %d", len(page_results))
        logger.info(
            "Ended at Sura #%d (%s), Aya %d",
            tracker.current_sura,
            sura_info.name,
            tracker.current_aya,
        )
        logger.info("=" * 60)

        # Build final output
        output: dict = {
            "status": "aborted_line_detection" if aborted else "completed",
            "pages_processed": len(page_results),
            "start_sura": cfg.start_sura,
            "start_aya": cfg.start_aya,
            "end_sura": tracker.current_sura,
            "end_aya": tracker.current_aya,
            "results": page_results,
        }
        if aborted and abort_detail:
            output["abort_reason"] = "line_geometry_failure"
            output["abort_at"] = abort_detail

        if cfg.export_coordinates and coordinate_pages:
            coordinate_data = {
                "exported_at": datetime.now(UTC).isoformat(),
                "start_sura": cfg.start_sura,
                "start_aya": cfg.start_aya,
                "end_sura": tracker.current_sura,
                "end_aya": tracker.current_aya,
                "pages_processed": len(coordinate_pages),
                "pages": coordinate_pages,
            }
            output["coordinates"] = coordinate_data

            # Also write coordinates to a JSON file
            try:
                with open(output_path, mode="w", encoding="utf-8") as f:
                    json.dump(coordinate_data, f, indent=2, ensure_ascii=False)
                logger.info("Coordinates saved to %s", output_path)
            except Exception as e:
                logger.error("Failed to write coordinates JSON: %s", e)

        # Clean up the file handler
        self._teardown_file_logging(file_handler)

        return output

    # ------------------------------------------------------------------
    # Logging helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _setup_file_logging(log_path: str) -> logging.FileHandler:
        """Add a file handler to the root logger for detailed pipeline logs."""
        file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s")
        )
        logging.getLogger().addHandler(file_handler)
        return file_handler

    @staticmethod
    def _teardown_file_logging(file_handler: logging.FileHandler) -> None:
        """Remove the file handler and close it."""
        logging.getLogger().removeHandler(file_handler)
        file_handler.close()

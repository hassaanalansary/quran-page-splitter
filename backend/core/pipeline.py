"""Pipeline: iterates over raw image bytes and delegates to PageProcessor.

Creates a QuranTracker that persists across all pages, builds PageContext
for each page, and collects results. Pure: returns plain dicts and writes no
files unless explicit ``output_path`` / ``log_path`` are provided.
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

logger = logging.getLogger(__name__)


class Pipeline:
    def __init__(self, processor: PageProcessor, export_config: ExportConfig):
        self.processor = processor
        self.export_config = export_config

    def run(
        self,
        images_data: list[tuple[bytes, str]],
        output_path: str | None = None,
        log_path: str | None = None,
    ) -> dict:
        """Process a batch of (raw_bytes, filename) pairs and return a result dict.

        Writes nothing unless ``output_path`` (coordinate JSON) or ``log_path``
        (detailed log file) are supplied.
        """
        file_handler = self._setup_file_logging(log_path) if log_path else None

        cfg = self.export_config
        tracker = QuranTracker(current_sura=cfg.start_sura, current_aya=cfg.start_aya)

        configure_opencv_acceleration()
        logger.info(
            "PIPELINE STARTED — Sura #%d, Aya %d, %d page(s)",
            tracker.current_sura,
            tracker.current_aya,
            len(images_data),
        )

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
                page_results.append({"filename": filename, "status": "error", "message": str(e)})
                continue

            ctx = create_context(img, filename, page_index, page_image_filename=None)
            result = self.processor.process(
                ctx,
                tracker,
                export_images=cfg.export_images,
                export_coordinates=cfg.export_coordinates,
                expected_lines=cfg.expected_lines,
            )

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
                    "detected_slots": result.get("detected_slots"),
                }
                for _, fn in images_data[page_index:]:
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
            if output_path:
                try:
                    with open(output_path, mode="w", encoding="utf-8") as f:
                        json.dump(coordinate_data, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    logger.error("Failed to write coordinates JSON: %s", e)

        if file_handler:
            self._teardown_file_logging(file_handler)

        return output

    # ------------------------------------------------------------------
    # Optional file-logging helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _setup_file_logging(log_path: str) -> logging.FileHandler:
        file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter("%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s"))
        logging.getLogger().addHandler(file_handler)
        return file_handler

    @staticmethod
    def _teardown_file_logging(file_handler: logging.FileHandler) -> None:
        logging.getLogger().removeHandler(file_handler)
        file_handler.close()

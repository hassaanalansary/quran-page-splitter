"""Pipeline: iterates over raw image bytes and delegates to PageProcessor.

Creates a QuranTracker that persists across all pages, builds PageContext
for each page, and collects results. Pure: returns plain dicts and writes no
files unless explicit ``output_path`` / ``log_path`` are provided.

Long runs are steerable from the outside without ``core`` learning anything
about the web layer: the caller passes plain callables — ``should_cancel`` to
stop between pages, and ``on_page_start`` / ``on_page_done`` to report progress
and persist each page as it lands.
"""

import io
import json
import logging
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
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


@dataclass(frozen=True)
class PageOutcome:
    """One finished page, handed to ``on_page_done`` the moment it completes."""

    #: 1-based position within this batch (NOT a logical page number).
    page_index: int
    filename: str
    status: str
    #: Engine coordinate page, or None when the page produced none.
    coordinates: dict | None
    #: The tracker's position after this page — where the next page resumes.
    end_sura: int
    end_aya: int


class Pipeline:
    def __init__(self, processor: PageProcessor, export_config: ExportConfig):
        self.processor = processor
        self.export_config = export_config

    def run(
        self,
        images_data: Iterable[tuple[bytes, str]],
        output_path: str | None = None,
        log_path: str | None = None,
        *,
        filenames: Sequence[str] | None = None,
        should_cancel: Callable[[], bool] | None = None,
        on_page_start: Callable[[int, str], None] | None = None,
        on_page_done: Callable[[PageOutcome], None] | None = None,
    ) -> dict:
        """Process a batch of (raw_bytes, filename) pairs and return a result dict.

        Writes nothing unless ``output_path`` (coordinate JSON) or ``log_path``
        (detailed log file) are supplied.

        ``images_data`` may be a lazy iterable — a generator that renders each
        page only when it is pulled — in which case ``filenames`` must carry the
        full ordered batch, since the batch size and the not-yet-processed tail
        cannot be read off an iterator without draining it. When ``filenames``
        is omitted, ``images_data`` must be a materialized sequence.

        ``should_cancel`` is polled once per page, *before* the next page is
        pulled: a cancelled run therefore never starts the render or the
        detection of the page it stops on, and the run settles as ``cancelled``.
        """
        file_handler = setup_file_logging(log_path) if log_path else None

        cfg = self.export_config
        tracker = QuranTracker(current_sura=cfg.start_sura, current_aya=cfg.start_aya)

        if filenames is None:
            images_data = list(images_data)
            names: Sequence[str] = [name for _, name in images_data]
        else:
            names = filenames
        pages_iter = iter(images_data)

        configure_opencv_acceleration()
        logger.info(
            "PIPELINE STARTED — Sura #%d, Aya %d, %d page(s)",
            tracker.current_sura,
            tracker.current_aya,
            len(names),
        )

        page_results: list[dict] = []
        coordinate_pages: list[dict] = []
        aborted = False
        cancelled = False
        abort_detail: dict | None = None
        cancel_detail: dict | None = None

        for page_index, filename in enumerate(names, start=1):
            if should_cancel is not None and should_cancel():
                cancelled = True
                cancel_detail = {"page_index": page_index, "filename": filename}
                self._append_skipped(page_results, names, page_index, "skipped_cancelled", "Not processed: cancelled")
                logger.warning("Batch cancelled before page %d (%s)", page_index, filename)
                break

            try:
                raw_bytes, _ = next(pages_iter)
            except StopIteration:
                # The source ran dry early (a short or interrupted generator).
                logger.error("Image source exhausted at page %d (%s)", page_index, filename)
                self._append_skipped(page_results, names, page_index, "skipped_no_image", "Not processed: no image")
                break

            if on_page_start is not None:
                on_page_start(page_index, filename)
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

            coord_page = result.pop("coordinates", None)
            if coord_page is not None:
                coordinate_pages.append(coord_page)

            page_results.append(result)

            if on_page_done is not None:
                on_page_done(
                    PageOutcome(
                        page_index=page_index,
                        filename=filename,
                        status=str(result.get("status", "")),
                        coordinates=coord_page,
                        end_sura=tracker.current_sura,
                        end_aya=tracker.current_aya,
                    )
                )

            if is_line_geometry_failure(result.get("status", "")):
                aborted = True
                abort_detail = {
                    "page_index": page_index,
                    "filename": filename,
                    "status": result.get("status"),
                    "expected_lines": result.get("expected_lines"),
                    "detected_lines": result.get("detected_lines"),
                    "detected_slots": result.get("detected_slots"),
                    "diagnostics": result.get("diagnostics"),
                    "line_debug_outputs": result.get("line_debug_outputs", []),
                }
                self._append_skipped(
                    page_results,
                    names,
                    page_index + 1,
                    "skipped_batch_abort",
                    "Not processed: batch aborted after line detection failure",
                )
                logger.error(
                    "Batch aborted at page %d (%s): %s",
                    page_index,
                    filename,
                    result.get("status"),
                )
                break

        if aborted:
            status = "aborted_line_detection"
        elif cancelled:
            status = "cancelled"
        else:
            status = "completed"

        output: dict = {
            "status": status,
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
        if cancelled and cancel_detail:
            output["cancel_at"] = cancel_detail

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
            teardown_file_logging(file_handler)

        return output

    @staticmethod
    def _append_skipped(
        page_results: list[dict],
        names: Sequence[str],
        from_index: int,
        status: str,
        message: str,
    ) -> None:
        """Record the untouched tail of the batch, from 1-based ``from_index`` on."""
        for name in names[from_index - 1 :]:
            page_results.append({"filename": name, "status": status, "message": message})


# ----------------------------------------------------------------------
# Optional file-logging helpers
# ----------------------------------------------------------------------


def setup_file_logging(log_path: str) -> logging.FileHandler:
    """Attach a DEBUG file handler to the root logger; returns it for teardown.

    Exposed at module level because a caller that drives several pipeline runs
    into one log file owns the handler for the whole span, not per run.
    """
    file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter("%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s"))
    logging.getLogger().addHandler(file_handler)
    return file_handler


def teardown_file_logging(file_handler: logging.FileHandler) -> None:
    """Detach and close a handler from :func:`setup_file_logging`."""
    logging.getLogger().removeHandler(file_handler)
    file_handler.close()

"""Unified page processor: detect → classify → split → track → export.

Orchestrates all pipeline stages for a single page and handles both
image export and coordinate collection based on the configured mode.
"""

import logging
from pathlib import Path

from PIL import Image

from core.aya_separator import AyaSeparatorProcessor
from core.context import PageContext, QuranTracker
from core.coordinate_exporter import collect_page_coordinates, track_positions
from core.image_utils import binarize_image, make_transparent
from core.line_detector import LineDetector

logger = logging.getLogger(__name__)

STATUS_NO_LINES = "no_lines"
STATUS_LINE_COUNT_MISMATCH = "line_count_mismatch"


def is_line_geometry_failure(status: str) -> bool:
    return status in (STATUS_NO_LINES, STATUS_LINE_COUNT_MISMATCH)


def _detection_diagnostics(ctx: PageContext) -> dict:
    """Page-coordinate diagnostics for an aborted page — the detected sura headers
    (with match scores), the text regions (with their allocated line count), and
    each detected line: everything the user needs to see WHY detection missed."""
    cb = ctx.crop_box
    ox = cb.left if cb else 0
    oy = cb.top if cb else 0
    cw = cb.width if cb else 0
    headers = [
        {
            "x": ox,
            "y": oy + hd["top"],
            "w": cw,
            "h": hd["bottom"] - hd["top"],
            "score": round(hd["score"], 4),
            "slots": hd["slots"],
        }
        for hd in ctx.detected_headers
    ]
    regions = [
        {"x": ox, "y": oy + rg["top"], "w": cw, "h": rg["bottom"] - rg["top"], "expected_lines": rg["slots"]}
        for rg in ctx.text_regions
    ]
    lines = [
        {
            "index": ln.line_index,
            "x": ln.bbox.left,
            "y": ln.bbox.top,
            "w": ln.bbox.width,
            "h": ln.bbox.height,
            "slots": ln.slot_count,
            "is_sura": ln.is_sura,
        }
        for ln in ctx.lines
    ]
    return {"headers": headers, "text_regions": regions, "lines": lines}


def create_context(
    image: Image.Image,
    filename: str,
    page_index: int,
    page_image_filename: str | None = None,
) -> PageContext:
    """Create a PageContext from a PIL image (binarizes once)."""
    grey, binary = binarize_image(image)
    return PageContext(
        image=image,
        grey=grey,
        binary=binary,
        filename=filename,
        page_index=page_index,
        page_image_filename=page_image_filename,
    )


class PageProcessor:
    def __init__(
        self,
        detector: LineDetector,
        aya_separator: AyaSeparatorProcessor,
        results_dir: Path,
    ):
        self.detector = detector
        self.aya_separator = aya_separator
        self.results_dir = results_dir

    def process(
        self,
        ctx: PageContext,
        tracker: QuranTracker,
        export_images: bool = False,
        export_coordinates: bool = True,
        expected_lines: int = 15,
    ) -> dict:
        """Full pipeline for one page: detect → classify → split → track → export.

        Always runs position tracking (needed for file naming with sura/aya info).
        Export flags control what output is produced.
        """
        logger.info("")
        logger.info("━" * 50)
        logger.info("📄 PAGE %d — %s", ctx.page_index, ctx.filename)
        logger.info("━" * 50)

        # Stage 1: Detect lines
        try:
            self.detector.detect(ctx, expected_lines=expected_lines)
        except Exception as e:
            logger.error("  ❌ Detection failed: %s", e)
            return {"filename": ctx.filename, "status": "error", "message": str(e)}

        if not ctx.lines:
            logger.warning("  ⚠ No lines detected")
            logger.error(
                "  Line count mismatch: page %d %s — expected %d, detected 0",
                ctx.page_index,
                ctx.filename,
                expected_lines,
            )
            return {
                "filename": ctx.filename,
                "status": STATUS_NO_LINES,
                "message": "No text lines detected",
                "outputs": [],
                "line_detection_ok": False,
                "expected_lines": expected_lines,
                "detected_lines": 0,
                "detected_slots": 0,
                "line_heights": [],
                "line_slots": [],
                "diagnostics": _detection_diagnostics(ctx),
            }

        detected_slots = sum(line.slot_count for line in ctx.lines)
        if detected_slots != expected_lines:
            line_heights = [line.bbox.height for line in ctx.lines]
            line_slots = [line.slot_count for line in ctx.lines]
            logger.error(
                "  Line slot mismatch: page %d %s — expected %d, detected %d",
                ctx.page_index,
                ctx.filename,
                expected_lines,
                detected_slots,
            )
            for line in ctx.lines:
                logger.error(
                    "  Line %d height=%d px slots=%d",
                    line.line_index,
                    line.bbox.height,
                    line.slot_count,
                )
            debug_paths = self._save_line_detection_debug(ctx)
            logger.error(
                "  Debug line PNGs: %d file(s) under line_detection_debug/",
                len(debug_paths),
            )
            return {
                "filename": ctx.filename,
                "status": STATUS_LINE_COUNT_MISMATCH,
                "message": (f"Expected {expected_lines} line slots, detected {detected_slots}"),
                "line_detection_ok": False,
                "expected_lines": expected_lines,
                "detected_lines": len(ctx.lines),
                "detected_slots": detected_slots,
                "line_heights": line_heights,
                "line_slots": line_slots,
                "line_debug_outputs": debug_paths,
                "diagnostics": _detection_diagnostics(ctx),
                "outputs": [],
            }

        # Stage 2: Split lines into aya segments
        self.aya_separator.split_segments(ctx)

        # Stage 3: Track sura/aya positions (always runs — needed for naming)
        track_positions(ctx, tracker)

        # Stage 4: Export
        result: dict = {
            "filename": ctx.filename,
            "status": "success",
            "detected_lines": len(ctx.lines),
            "detected_slots": detected_slots,
            "line_detection_ok": True,
            "expected_lines": expected_lines,
            "line_heights": [line.bbox.height for line in ctx.lines],
            "line_slots": [line.slot_count for line in ctx.lines],
        }

        if export_images:
            saved = self._export_images(ctx)
            result["outputs"] = saved
            result["exported_images"] = len(saved)
            logger.info("  Exported %d image(s) for %s", len(saved), ctx.filename)

        if export_coordinates:
            result["coordinates"] = collect_page_coordinates(ctx, self.detector.detection.padding)

        logger.info("  Finished %s: detected=%d lines", ctx.filename, len(ctx.lines))
        return result

    def _export_images(self, ctx: PageContext) -> list[str]:
        """Export all lines/segments as transparent PNGs with sura/aya naming."""
        saved: list[str] = []
        stem = Path(ctx.filename).stem

        for line in ctx.lines:
            if line.is_sura:
                name = f"{stem}-l{line.line_index:02d}-sura{line.sura_number:03d}-header.png"
                out_path = self.results_dir / name
                make_transparent(ctx.line_image(line)).save(out_path)
                saved.append(str(out_path))
                logger.info("    Saved %s", out_path)
                continue

            if line.is_besmella:
                name = f"{stem}-l{line.line_index:02d}-sura{line.sura_number:03d}-besmella.png"
                out_path = self.results_dir / name
                make_transparent(ctx.line_image(line)).save(out_path)
                saved.append(str(out_path))
                logger.info("    Saved %s", out_path)
                continue

            for seg_idx, seg in enumerate(line.segments, start=1):
                # Build filename with sura/aya info
                sura_part = f"-sura{seg.sura_number:03d}" if seg.sura_number else ""
                aya_part = f"-aya{seg.aya_number:03d}" if seg.aya_number else ""

                if len(line.segments) == 1:
                    name = f"{stem}-l{line.line_index:02d}{sura_part}{aya_part}.png"
                else:
                    name = f"{stem}-l{line.line_index:02d}-s{seg_idx:02d}{sura_part}{aya_part}.png"

                # Crop segment from original image
                b = seg.bbox
                seg_image = ctx.image.crop((b.left, b.top, b.right, b.bottom))
                out_path = self.results_dir / name
                make_transparent(seg_image).save(out_path)
                saved.append(str(out_path))
                logger.info("    Saved %s", out_path)

        return saved

    def _save_line_detection_debug(self, ctx: PageContext) -> list[str]:
        """Save each detected line as PNG for inspection when count ≠ expected."""
        stem = Path(ctx.filename).stem
        safe_stem = stem.replace("/", "_").replace("\\", "_")
        out_dir = self.results_dir / "line_detection_debug" / f"page_{ctx.page_index:04d}_{safe_stem}"
        out_dir.mkdir(parents=True, exist_ok=True)
        saved: list[str] = []
        for line in ctx.lines:
            out_path = out_dir / f"line_{line.line_index:02d}.png"
            make_transparent(ctx.line_image(line)).save(out_path)
            saved.append(str(out_path))
        return saved

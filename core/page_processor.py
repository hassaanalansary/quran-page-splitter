"""Unified page processor: detect → classify → split → track → export.

Orchestrates all pipeline stages for a single page and handles both
image export and coordinate collection based on the configured mode.
"""

import logging
from pathlib import Path

from PIL import Image

from core.aya_separator import AyaSeparatorProcessor
from core.classifier import SuraClassifier
from core.context import PageContext, QuranTracker
from core.coordinate_exporter import collect_page_coordinates, track_positions
from core.line_detector import LineDetector
from image_utils import binarize_image, make_transparent

logger = logging.getLogger(__name__)


def create_context(image: Image.Image, filename: str, page_index: int) -> PageContext:
    """Create a PageContext from a PIL image (binarizes once)."""
    grey, binary = binarize_image(image)
    return PageContext(
        image=image,
        grey=grey,
        binary=binary,
        filename=filename,
        page_index=page_index,
    )


class PageProcessor:
    def __init__(
        self,
        detector: LineDetector,
        classifier: SuraClassifier,
        aya_separator: AyaSeparatorProcessor,
        results_dir: Path,
    ):
        self.detector = detector
        self.classifier = classifier
        self.aya_separator = aya_separator
        self.results_dir = results_dir

    def process(
        self,
        ctx: PageContext,
        tracker: QuranTracker,
        export_images: bool = True,
        export_coordinates: bool = False,
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
            self.detector.detect(ctx)
        except Exception as e:
            logger.error("  ❌ Detection failed: %s", e)
            return {"filename": ctx.filename, "status": "error", "message": str(e)}

        if not ctx.lines:
            logger.warning("  ⚠ No lines detected")
            return {
                "filename": ctx.filename,
                "status": "no_lines",
                "message": "No text lines detected",
                "outputs": [],
            }

        # Stage 2: Classify sura headers
        try:
            self.classifier.classify(ctx)
        except Exception as e:
            logger.warning("  Classification failed, skipping: %s", e)

        # Stage 3: Split lines into aya segments
        self.aya_separator.split_segments(ctx)

        # Stage 4: Track sura/aya positions (always runs — needed for naming)
        track_positions(ctx, tracker)

        # Stage 5: Export
        result: dict = {
            "filename": ctx.filename,
            "status": "success",
            "detected_lines": len(ctx.lines),
        }

        if export_images:
            saved = self._export_images(ctx)
            result["outputs"] = saved
            result["exported_images"] = len(saved)
            logger.info("  Exported %d image(s) for %s", len(saved), ctx.filename)

        if export_coordinates:
            result["coordinates"] = collect_page_coordinates(ctx)

        logger.info("  Finished %s: detected=%d lines", ctx.filename, len(ctx.lines))
        return result

    def _export_images(self, ctx: PageContext) -> list[str]:
        """Export all lines/segments as transparent PNGs with sura/aya naming."""
        saved: list[str] = []
        stem = Path(ctx.filename).stem

        for line in ctx.lines:
            if line.is_sura:
                name = (
                    f"{stem}-l{line.line_index:02d}"
                    f"-sura{line.sura_number:03d}-header.png"
                )
                out_path = self.results_dir / name
                make_transparent(ctx.line_image(line)).save(out_path)
                saved.append(str(out_path))
                logger.info("    Saved %s", out_path)
                continue

            if line.is_basmala:
                name = (
                    f"{stem}-l{line.line_index:02d}"
                    f"-sura{line.sura_number:03d}-basmala.png"
                )
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
                    name = (
                        f"{stem}-l{line.line_index:02d}-s{seg_idx:02d}"
                        f"{sura_part}{aya_part}.png"
                    )

                # Crop segment from original image
                b = seg.bbox
                seg_image = ctx.image.crop((b.left, b.top, b.right, b.bottom))
                out_path = self.results_dir / name
                make_transparent(seg_image).save(out_path)
                saved.append(str(out_path))
                logger.info("    Saved %s", out_path)

        return saved

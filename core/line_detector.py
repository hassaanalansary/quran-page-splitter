"""Line detection: crops the page and populates PageContext with detected lines."""

import logging

from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.context import BBox, LineResult, PageContext
from core.line_detection_recovery import try_recover_line_count
from script.line_cutter import get_line_boxes

logger = logging.getLogger(__name__)


class LineDetector:
    def __init__(
        self,
        crop: CropConfig,
        detection: DetectionConfig,
        processing: ProcessingConfig | None = None,
    ):
        self.crop = crop
        self.detection = detection
        self.processing = processing or ProcessingConfig()

    @staticmethod
    def _set_lines_from_boxes(
        ctx: PageContext,
        left: int,
        top: int,
        boxes: list[dict[str, int]],
    ) -> None:
        ctx.lines.clear()
        for i, box in enumerate(boxes, start=1):
            line_bbox = BBox(
                left=left + box["left"],
                top=top + box["top"],
                right=left + box["right"],
                bottom=top + box["bottom"],
            )
            ctx.lines.append(LineResult(bbox=line_bbox, line_index=i))

    def detect(self, ctx: PageContext, expected_lines: int | None = None) -> None:
        """Compute crop region, detect lines, populate ctx.crop_box and ctx.lines.

        Line bounding boxes are stored in original page coordinates.

        When ``expected_lines`` is set and the initial count differs, Phase C tries a
        bounded **gap_threshold** sweep only (``min_line_height`` comes from config /
        ``min_line_height_floor``; no MH recovery). If no gap hits the expected count,
        lines stay at the base result and the pipeline reports mismatch / abort.
        """
        x, y, w, h = self.crop.as_tuple()
        img_w, img_h = ctx.image.size

        should_swap = (
            self.processing.alternate_horizontal_margin and ctx.page_index % 2 == 0
        )
        crop_x = (img_w - (x + w)) if should_swap else x

        left = max(0, crop_x)
        top = max(0, y)
        right = min(img_w, left + w)
        bottom = min(img_h, top + h)

        if right <= left or bottom <= top:
            raise ValueError("Crop rectangle is outside image bounds")

        ctx.crop_box = BBox(left=left, top=top, right=right, bottom=bottom)

        ctx.line_detection_recovery = None

        cropped_binary = ctx.cropped_binary()
        boxes = get_line_boxes(cropped_binary, **self.detection.as_dict())
        self._set_lines_from_boxes(ctx, left, top, boxes)

        if expected_lines is not None and len(ctx.lines) != expected_lines:
            initial_n = len(ctx.lines)
            logger.info(
                "  Phase C: base count %d (expected %d), searching alternate params",
                initial_n,
                expected_lines,
            )
            recovered = try_recover_line_count(
                cropped_binary,
                self.detection,
                expected_lines,
                initial_n,
            )
            if recovered is not None:
                rec_boxes, used = recovered
                self._set_lines_from_boxes(ctx, left, top, rec_boxes)
                ctx.line_detection_recovery = used
                logger.info(
                    "  Phase C recovery: %d lines via gap_threshold=%s (effective min_line_height=%s, padding=%s)",
                    expected_lines,
                    used.gap_threshold,
                    used.effective_min_line_height(),
                    used.padding,
                )

        logger.info("  Detected %d lines", len(ctx.lines))

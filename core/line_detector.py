"""Line detection: crops the page and populates PageContext with detected lines."""

import logging

from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.context import BBox, LineResult, PageContext
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

    def detect(self, ctx: PageContext) -> None:
        """Compute crop region, detect lines, populate ctx.crop_box and ctx.lines.

        Line bounding boxes are stored in original page coordinates.
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

        # Detect lines in the cropped region using the binary view
        cropped_binary = ctx.cropped_binary()
        boxes = get_line_boxes(cropped_binary, **self.detection.as_dict())

        # Convert local crop coords → original page coords
        for i, box in enumerate(boxes, start=1):
            line_bbox = BBox(
                left=left + box["left"],
                top=top + box["top"],
                right=left + box["right"],
                bottom=top + box["bottom"],
            )
            ctx.lines.append(LineResult(bbox=line_bbox, line_index=i))

        logger.info("  Detected %d lines", len(ctx.lines))

"""Line detection logic wrapped in a class."""

import logging
from dataclasses import dataclass

from PIL import Image

from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.page_processor import Page
from script.line_cutter import crop_lines, get_line_boxes

logger = logging.getLogger(__name__)


@dataclass
class DetectedLine:
    """A detected text line with its image and bounding box in original page coords."""

    image: Image.Image
    bbox: dict  # {left, top, right, bottom} in original page pixel coords


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

    def _compute_crop_origin(
        self, page: Page, page_index: int
    ) -> tuple[int, int, Page]:
        """Compute the crop region and return (origin_x, origin_y, cropped_image).

        The origin is the top-left corner of the crop region in the
        original page coordinate space.
        """
        x, y, w, h = self.crop.as_tuple()
        img_w, img_h = page.image.size
        should_swap = (
            self.processing.alternate_horizontal_margin and page_index % 2 == 0
        )
        crop_x = (img_w - (x + w)) if should_swap else x
        left = max(0, crop_x)
        top = max(0, y)
        right = min(img_w, left + w)
        bottom = min(img_h, top + h)
        if right <= left or bottom <= top:
            raise ValueError("Crop rectangle is outside image bounds")

        cropped = Page(
            image=page.image.crop((left, top, right, bottom)),
            grey=page.grey[top:bottom, left:right],
            binary=page.binary[top:bottom, left:right],
        )
        return left, top, cropped

    def _crop(self, page: Page, page_index: int) -> Page:
        return self._compute_crop_origin(page, page_index)[2]

    def detect(self, page: Page, page_index: int = 0) -> list[Page]:
        """Crop the image then return detected line images."""
        cropped = self._crop(page, page_index)
        lines = crop_lines(cropped, **self.detection.as_dict())
        logger.info("Detected %d lines", len(lines))
        return lines

    def detect_with_coords(self, page: Page, page_index: int = 0) -> list[DetectedLine]:
        """Crop the image and return lines with bboxes in original page coords."""
        origin_x, origin_y, cropped = self._compute_crop_origin(page, page_index)
        boxes = get_line_boxes(cropped.binary, **self.detection.as_dict())

        results: list[DetectedLine] = []
        for box in boxes:
            line_img = cropped.image.crop(
                (box["left"], box["top"], box["right"], box["bottom"])
            )
            page_bbox = {
                "left": origin_x + box["left"],
                "top": origin_y + box["top"],
                "right": origin_x + box["right"],
                "bottom": origin_y + box["bottom"],
            }
            results.append(DetectedLine(image=line_img, bbox=page_bbox))

        logger.info("Detected %d lines (with coords)", len(results))
        return results

"""Line detection logic wrapped in a class."""

import logging
from dataclasses import dataclass

from PIL import Image

from core.config import CropConfig, DetectionConfig, ProcessingConfig
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
        self, img: Image.Image, page_index: int
    ) -> tuple[int, int, Image.Image]:
        """Compute the crop region and return (origin_x, origin_y, cropped_image).

        The origin is the top-left corner of the crop region in the
        original page coordinate space.
        """
        x, y, w, h = self.crop.as_tuple()
        img_w, img_h = img.size
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
        cropped = img.crop((left, top, right, bottom))
        return left, top, cropped

    def _crop(self, img: Image.Image, page_index: int) -> Image.Image:
        _, _, cropped = self._compute_crop_origin(img, page_index)
        return cropped

    def detect(self, img: Image.Image, page_index: int = 0) -> list[Image.Image]:
        """Crop the image then return detected line images."""
        cropped = self._crop(img, page_index)
        lines = crop_lines(cropped, **self.detection.as_dict())
        logger.info("Detected %d lines", len(lines))
        return lines

    def detect_with_coords(
        self, img: Image.Image, page_index: int = 0
    ) -> list[DetectedLine]:
        """Crop the image and return lines with bboxes in original page coords."""
        origin_x, origin_y, cropped = self._compute_crop_origin(img, page_index)
        boxes = get_line_boxes(cropped, **self.detection.as_dict())

        results: list[DetectedLine] = []
        for box in boxes:
            line_img = cropped.crop(
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

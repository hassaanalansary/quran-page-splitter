"""Aya separator preprocessing and line splitting helpers."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


@dataclass
class AyaSeparatorConfig:
    match_threshold: float = 0.35
    short_line_ratio: float = 0.98
    min_segment_width: int = 8


@dataclass
class SegmentResult:
    """A segment produced by splitting a line at aya separators."""

    image: Image.Image
    x_start: int  # left edge in the *original* (untrimmed) line image
    x_end: int  # right edge in the *original* (untrimmed) line image
    has_separator: bool  # True if this segment contains an aya separator


class AyaSeparatorProcessor:
    def __init__(self, template: Image.Image, config: AyaSeparatorConfig | None = None):
        self.config = config or AyaSeparatorConfig()
        self.template = self._prepare_template(template)

    def split_line(self, line_image: Image.Image) -> list[Image.Image]:
        maybe_trimmed = self._trim_if_short(line_image)
        boxes = self._detect_separator_boxes(maybe_trimmed)
        if not boxes:
            return [maybe_trimmed]
        return self._split_by_boxes(maybe_trimmed, boxes)

    def split_line_with_coords(self, line_image: Image.Image) -> list[SegmentResult]:
        """Split a line and return segments with coordinate info.

        Each SegmentResult has x_start/x_end relative to the *original*
        (untrimmed) line image, and a has_separator flag indicating whether
        the segment contains an aya separator ornament.
        """
        maybe_trimmed, trim_x = self._trim_if_short_with_offset(line_image)
        boxes = self._detect_separator_boxes(maybe_trimmed)

        if not boxes:
            return [
                SegmentResult(
                    image=maybe_trimmed,
                    x_start=trim_x,
                    x_end=trim_x + maybe_trimmed.width,
                    has_separator=False,
                )
            ]

        return self._split_by_boxes_with_coords(maybe_trimmed, boxes, trim_x)

    def _prepare_template(self, template: Image.Image) -> np.ndarray:
        trimmed = self._trim_to_content(template)
        gray = np.array(trimmed.convert("L"), dtype=np.uint8)
        _, binary_inv = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )

        # Remove inner number by masking the central area.
        h, w = binary_inv.shape
        cx1, cx2 = int(w * 0.20), int(w * 0.80)
        cy1, cy2 = int(h * 0.20), int(h * 0.80)
        binary_inv[cy1:cy2, cx1:cx2] = 0

        return binary_inv

    def _trim_if_short(self, line_image: Image.Image) -> Image.Image:
        trimmed = self._trim_to_content(line_image)
        ratio = trimmed.width / max(1, line_image.width)
        if ratio < self.config.short_line_ratio:
            return trimmed
        return line_image

    def _trim_if_short_with_offset(
        self, line_image: Image.Image
    ) -> tuple[Image.Image, int]:
        """Trim short lines and return (trimmed_image, x_offset_in_original)."""
        trimmed, x_offset = self._trim_to_content_with_offset(line_image)
        ratio = trimmed.width / max(1, line_image.width)
        if ratio < self.config.short_line_ratio:
            return trimmed, x_offset
        return line_image, 0

    def _trim_to_content(self, image: Image.Image) -> Image.Image:
        gray = np.array(image.convert("L"), dtype=np.uint8)
        _, binary_inv = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
        non_zero = cv2.findNonZero(binary_inv)
        if non_zero is None:
            return image
        x, y, w, h = cv2.boundingRect(non_zero)
        return image.crop((x, y, x + w, y + h))

    def _trim_to_content_with_offset(
        self, image: Image.Image
    ) -> tuple[Image.Image, int]:
        """Trim to content and return (trimmed_image, x_offset)."""
        gray = np.array(image.convert("L"), dtype=np.uint8)
        _, binary_inv = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
        non_zero = cv2.findNonZero(binary_inv)
        if non_zero is None:
            return image, 0
        x, y, w, h = cv2.boundingRect(non_zero)
        return image.crop((x, y, x + w, y + h)), x

    def _detect_separator_boxes(self, line_image: Image.Image) -> list[tuple[int, int]]:
        line_gray = np.array(line_image.convert("L"), dtype=np.uint8)
        _, line_binary = cv2.threshold(
            line_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
        template = self.template

        best_scores = None
        best_template_w = template.shape[1]

        # 1. DYNAMIC SCALING
        # Base the scaling on the line's actual height rather than a fixed ratio.
        # This prevents the template from being too massive or too tiny.
        base_scale = line_binary.shape[0] / template.shape[0]

        # Test scales from 60% to 130% of the base line height
        scales = np.arange(base_scale * 0.60, base_scale * 1.31, base_scale * 0.05)

        # 2. VERTICAL PADDING
        # If the line is cropped tightly, the top and bottom of the Aya separator
        # might be cut off. We pad the binary image vertically with black (0)
        # so taller scaled templates don't cause dimension errors and get skipped.
        max_h = int(template.shape[0] * max(scales))
        pad_y = max(0, max_h - line_binary.shape[0]) // 2 + 5

        padded_line = cv2.copyMakeBorder(
            line_binary, pad_y, pad_y, 0, 0, cv2.BORDER_CONSTANT, value=0
        )

        for scale in scales:
            new_h = int(template.shape[0] * scale)
            new_w = int(template.shape[1] * scale)

            # Guard against invalid dimensions for cv2.matchTemplate
            if new_h <= 0 or new_w <= 0 or new_w >= padded_line.shape[1]:
                continue

            scaled = cv2.resize(template, (new_w, new_h), interpolation=cv2.INTER_AREA)
            match_map = cv2.matchTemplate(padded_line, scaled, cv2.TM_CCOEFF_NORMED)

            # Collapse the 2D match map to 1D
            # (taking the max score across all Y positions)
            scores = match_map.max(axis=0)

            if best_scores is None or scores.max() > best_scores.max():
                best_scores = scores
                best_template_w = new_w

        if best_scores is None or best_scores.max() < self.config.match_threshold:
            return []

        candidate_x = np.where(best_scores >= self.config.match_threshold)[0]
        if candidate_x.size == 0:
            return []

        # Keep strongest non-overlapping matches
        by_score = sorted(
            candidate_x.tolist(), key=lambda x: float(best_scores[x]), reverse=True
        )
        min_gap = max(4, int(best_template_w * 0.6))
        selected: list[int] = []
        for x in by_score:
            if all(abs(x - s) >= min_gap for s in selected):
                selected.append(x)

        selected.sort()

        # Because we only padded vertically, the X coordinates remain perfectly intact
        # and seamlessly map back to the original unpadded line_image.
        return [(x, x + best_template_w) for x in selected]

    def _split_by_boxes(
        self, line_image: Image.Image, boxes: list[tuple[int, int]]
    ) -> list[Image.Image]:
        """Split line at separator boxes, producing segments in RTL order.

        Cuts at the LEFT edge of each separator so the separator circle
        is included with the aya text to its right (the aya it terminates).
        """
        width, height = line_image.size
        min_w = self.config.min_segment_width
        parts: list[Image.Image] = []
        end = width
        for left, _ in reversed(boxes):  # right-to-left
            cut = max(0, left)
            if end - cut >= min_w:
                parts.append(line_image.crop((cut, 0, end, height)))
            end = cut
        # Leftmost remaining text
        if end >= min_w:
            parts.append(line_image.crop((0, 0, end, height)))
        return parts if parts else [line_image]

    def _split_by_boxes_with_coords(
        self,
        line_image: Image.Image,
        boxes: list[tuple[int, int]],
        trim_x: int,
    ) -> list[SegmentResult]:
        """Split at separator boxes and return SegmentResults in RTL order.

        Coordinates are translated back to the original (untrimmed) line
        image space by adding ``trim_x``.
        """
        width, height = line_image.size
        min_w = self.config.min_segment_width
        results: list[SegmentResult] = []
        end = width

        for left, _ in reversed(boxes):  # right-to-left
            cut = max(0, left)
            if end - cut >= min_w:
                results.append(
                    SegmentResult(
                        image=line_image.crop((cut, 0, end, height)),
                        x_start=trim_x + cut,
                        x_end=trim_x + end,
                        has_separator=True,
                    )
                )
            end = cut

        # Leftmost remaining text — no separator
        if end >= min_w:
            results.append(
                SegmentResult(
                    image=line_image.crop((0, 0, end, height)),
                    x_start=trim_x,
                    x_end=trim_x + end,
                    has_separator=False,
                )
            )

        if not results:
            return [
                SegmentResult(
                    image=line_image,
                    x_start=trim_x,
                    x_end=trim_x + width,
                    has_separator=False,
                )
            ]
        return results

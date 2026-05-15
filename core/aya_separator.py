"""Aya separator detection and line splitting.

Detects aya separator ornaments within text lines using multi-scale
template matching, then splits each line into segments. Mutates
PageContext by populating line.segments.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from core.context import BBox, LineResult, PageContext, SegmentResult
from core.opencv_accel import (
    match_template_ccoeff_normed,
    resize_area,
    upload_gray_for_matching,
)
from core.protected_bands import IgnoreRect
from image_utils import binarize_image, find_content_bbox

logger = logging.getLogger(__name__)


@dataclass
class AyaSeparatorConfig:
    match_threshold: float = 0.5
    short_line_ratio: float = 0.98
    min_segment_width: int = 20


class AyaSeparatorProcessor:
    def __init__(
        self,
        template: Image.Image,
        config: AyaSeparatorConfig | None = None,
        ignore_rect: IgnoreRect | None = None,
    ):
        self.config = config or AyaSeparatorConfig()
        self.template = self._prepare_template(template, ignore_rect)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def split_segments(self, ctx: PageContext) -> None:
        """Detect aya separators in each non-sura line and populate segments.

        Mutates ctx.lines by setting line.segments and line.content_bbox.
        """
        for line in ctx.lines:
            if line.is_sura or line.is_basmala:
                continue

            line_binary = ctx.line_binary(line)

            # Compute and cache the tight content bounding box
            content_result = find_content_bbox(line_binary)
            if content_result is None:
                # Empty line — single empty segment
                line.segments.append(SegmentResult(bbox=line.bbox, has_separator=False))
                continue

            cx, cy, cw, ch = content_result
            line.content_bbox = BBox(
                left=line.bbox.left + cx,
                top=line.bbox.top + cy,
                right=line.bbox.left + cx + cw,
                bottom=line.bbox.top + cy + ch,
            )

            # Determine if line is "short" (content narrower than full line)
            content_ratio = cw / max(1, line.bbox.width)
            if content_ratio < self.config.short_line_ratio:
                # Use trimmed content region for separator detection
                detect_binary = line_binary[cy : cy + ch, cx : cx + cw]
                detect_offset_x = cx
                detect_width = cw
            else:
                detect_binary = line_binary
                detect_offset_x = 0
                detect_width = line.bbox.width

            # Detect separator positions
            boxes = self._detect_separator_boxes(detect_binary)

            if not boxes:
                # No separators — single segment
                seg_bbox = (
                    line.content_bbox
                    if content_ratio < self.config.short_line_ratio
                    else line.bbox
                )
                line.segments.append(SegmentResult(bbox=seg_bbox, has_separator=False))
                continue

            # Split at separator positions (RTL order)
            self._create_segments(line, boxes, detect_offset_x, detect_width)

            sep_count = sum(1 for s in line.segments if s.has_separator)
            logger.info(
                "  Line %d: %d segment(s), %d separator(s)",
                line.line_index,
                len(line.segments),
                sep_count,
            )

    # ------------------------------------------------------------------
    # Template preparation
    # ------------------------------------------------------------------

    def _prepare_template(
        self,
        template: Image.Image,
        ignore_rect: IgnoreRect | None,
    ) -> np.ndarray:
        """Prepare separator template: binarize and mask the central number."""
        if ignore_rect is not None:
            trimmed = template
        else:
            trimmed = self._trim_template_to_content(template)
        _, binary_inv = binarize_image(trimmed)

        h, w = binary_inv.shape
        if ignore_rect is None:
            # Remove inner number by masking the central area
            cx1, cx2 = int(w * 0.20), int(w * 0.80)
            cy1, cy2 = int(h * 0.20), int(h * 0.80)
        else:
            cx1 = max(0, min(w, ignore_rect.x))
            cy1 = max(0, min(h, ignore_rect.y))
            cx2 = max(0, min(w, ignore_rect.x + ignore_rect.w))
            cy2 = max(0, min(h, ignore_rect.y + ignore_rect.h))
        binary_inv[cy1:cy2, cx1:cx2] = 0

        return binary_inv

    def _trim_template_to_content(self, image: Image.Image) -> Image.Image:
        """Trim template image to its non-empty content."""
        gray = np.array(image.convert("L"), dtype=np.uint8)
        _, binary_inv = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
        result = find_content_bbox(binary_inv)
        if result is None:
            return image
        x, y, w, h = result
        return image.crop((x, y, x + w, y + h))

    # ------------------------------------------------------------------
    # Separator detection
    # ------------------------------------------------------------------

    def _detect_separator_boxes(self, line_binary: np.ndarray) -> list[tuple[int, int]]:
        """Detect separator ornament positions via multi-scale template matching.

        Returns list of (x_start, x_end) tuples in the coordinate space
        of the input line_binary array.
        """
        template = self.template

        best_scores = None
        best_template_w = template.shape[1]

        # Dynamic scaling based on line height
        base_scale = line_binary.shape[0] / template.shape[0]
        scales = np.arange(base_scale * 0.60, base_scale * 1.31, base_scale * 0.05)

        # Vertical padding so taller scaled templates fit
        max_h = int(template.shape[0] * max(scales))
        pad_y = max(0, max_h - line_binary.shape[0]) // 2 + 5

        padded_line = cv2.copyMakeBorder(
            line_binary, pad_y, pad_y, 0, 0, cv2.BORDER_CONSTANT, value=0
        )

        padded_for_match = upload_gray_for_matching(padded_line)

        for scale in scales:
            new_h = int(template.shape[0] * scale)
            new_w = int(template.shape[1] * scale)

            if new_h <= 0 or new_w <= 0 or new_w >= padded_line.shape[1]:
                continue

            scaled = resize_area(template, (new_w, new_h))
            match_map = match_template_ccoeff_normed(padded_for_match, scaled)

            # Collapse 2D match map to 1D (max score across Y positions)
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
            candidate_x.tolist(),
            key=lambda x: float(best_scores[x]),
            reverse=True,
        )
        min_gap = max(4, int(best_template_w * 0.6))
        selected: list[int] = []
        for x in by_score:
            if all(abs(x - s) >= min_gap for s in selected):
                selected.append(x)

        selected.sort()

        return [(x, x + best_template_w) for x in selected]

    # ------------------------------------------------------------------
    # Segment creation
    # ------------------------------------------------------------------

    def _create_segments(
        self,
        line: LineResult,
        boxes: list[tuple[int, int]],
        detect_offset_x: int,
        detect_width: int,
    ) -> None:
        """Create SegmentResult objects from separator boxes in RTL order.

        Cuts at the LEFT edge of each separator so the separator ornament
        is included with the aya text to its right (the aya it terminates).

        Coordinates are translated to original page space.
        """
        min_w = self.config.min_segment_width
        end = detect_width  # in detect region coords

        for sep_left, _ in reversed(boxes):  # right-to-left
            cut = max(0, sep_left)
            seg_width = end - cut
            if seg_width >= min_w:
                line.segments.append(
                    SegmentResult(
                        bbox=BBox(
                            left=line.bbox.left + detect_offset_x + cut,
                            top=line.bbox.top,
                            right=line.bbox.left + detect_offset_x + end,
                            bottom=line.bbox.bottom,
                        ),
                        has_separator=True,
                    )
                )
            end = cut

        # Leftmost remaining text — no separator
        if end >= min_w:
            line.segments.append(
                SegmentResult(
                    bbox=BBox(
                        left=line.bbox.left + detect_offset_x,
                        top=line.bbox.top,
                        right=line.bbox.left + detect_offset_x + end,
                        bottom=line.bbox.bottom,
                    ),
                    has_separator=False,
                )
            )

        # Fallback: if no segments were created, use the whole line
        if not line.segments:
            line.segments.append(SegmentResult(bbox=line.bbox, has_separator=False))

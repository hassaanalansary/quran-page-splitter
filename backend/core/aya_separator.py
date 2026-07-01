"""Aya separator detection and line splitting.

Detects aya separator ornaments within text lines using fixed-size
grayscale template matching, then splits each line into segments. Mutates
PageContext by populating line.segments.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from PIL import Image

from core.context import BBox, LineResult, PageContext, SegmentResult
from core.image_utils import find_content_bbox
from core.template_matching import IgnoreRect, locate_x_matches, make_template_spec

logger = logging.getLogger(__name__)


@dataclass
class AyaSeparatorConfig:
    match_threshold: float = 0.35
    short_line_ratio: float = 0.98
    min_segment_width: int = 20


class AyaSeparatorProcessor:
    def __init__(
        self,
        template: Image.Image,
        config: AyaSeparatorConfig | None = None,
        ignore_rect: IgnoreRect | None = None,
        *,
        prefer_acceleration: bool = True,
    ):
        self.config = config or AyaSeparatorConfig()
        self.template = make_template_spec(
            template,
            ignore_rect,
            self.config.match_threshold,
            "aya_separator",
            prefer_acceleration=prefer_acceleration,
        )

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
            line_gray = ctx.line_grey(line)
            if content_ratio < self.config.short_line_ratio:
                # Use trimmed content region for separator detection
                detect_gray = line_gray[cy : cy + ch, cx : cx + cw]
                detect_offset_x = cx
                detect_width = cw
            else:
                detect_gray = line_gray
                detect_offset_x = 0
                detect_width = line.bbox.width

            # Detect separator positions
            boxes = locate_x_matches(detect_gray, self.template)

            if not boxes:
                # No separators — single segment
                seg_bbox = line.content_bbox if content_ratio < self.config.short_line_ratio else line.bbox
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

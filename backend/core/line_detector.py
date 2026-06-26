"""Line detection: crops the page and populates PageContext with detected lines."""

import logging
from dataclasses import dataclass

import numpy as np
from backend.core.image_utils import find_content_bbox

from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.context import BBox, LineResult, PageContext
from core.protected_bands import ProtectedBand, ProtectedBandLocator
from script.line_cutter import split_by_valleys

logger = logging.getLogger(__name__)


@dataclass
class _DetectedBand:
    box: dict[str, int]
    is_sura: bool = False
    is_basmala: bool = False
    slot_count: int = 1


@dataclass
class _TextRegion:
    top: int
    bottom: int
    content_height: int
    slots: int = 0


class LineDetector:
    def __init__(
        self,
        crop: CropConfig,
        detection: DetectionConfig,
        processing: ProcessingConfig | None = None,
        protected_locator: ProtectedBandLocator | None = None,
    ):
        self.crop = crop
        self.detection = detection
        self.processing = processing or ProcessingConfig()
        self.protected_locator = protected_locator

    @staticmethod
    def _set_lines_from_bands(
        ctx: PageContext,
        left: int,
        top: int,
        bands: list[_DetectedBand],
    ) -> None:
        ctx.lines.clear()
        for i, band in enumerate(bands, start=1):
            box = band.box
            line_bbox = BBox(
                left=left + box["left"],
                top=top + box["top"],
                right=left + box["right"],
                bottom=top + box["bottom"],
            )

            ctx.lines.append(
                LineResult(
                    bbox=line_bbox,
                    line_index=i,
                    slot_count=band.slot_count,
                    is_sura=band.is_sura,
                    is_basmala=band.is_basmala,
                )
            )

    def detect(self, ctx: PageContext, expected_lines: int | None = None) -> None:
        """Compute crop region, detect lines, populate ctx.crop_box and ctx.lines.

        Uses valley-based splitting: finds the N-1 most prominent valleys
        in the row-sum profile to produce exactly N line boxes.  No global
        threshold or minimum height parameter is needed.
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

        n_lines = expected_lines or 15
        cropped_grey = ctx.cropped_grey()
        cropped_binary = ctx.cropped_binary()

        logger.info("Start detecting bands")
        bands = self._detect_bands(cropped_grey, cropped_binary, n_lines)
        self._set_lines_from_bands(ctx, left, top, bands)

        logger.info("  Detected %d lines", len(ctx.lines))

    def _detect_bands(
        self,
        grey: np.ndarray,
        binary: np.ndarray,
        expected_lines: int,
    ) -> list[_DetectedBand]:
        protected = (
            self.protected_locator.locate(grey)
            if self.protected_locator is not None
            else []
        )
        if not protected:
            return [
                _DetectedBand(box=box)
                for box in split_by_valleys(
                    grey,
                    binary,
                    expected_lines,
                    self.detection.padding,
                )
            ]

        return self._detect_with_protected_bands(
            grey,
            binary,
            expected_lines,
            protected,
        )

    def _detect_with_protected_bands(
        self,
        grey: np.ndarray,
        binary: np.ndarray,
        expected_lines: int,
        protected: list[ProtectedBand],
    ) -> list[_DetectedBand]:
        protected_slots = sum(band.slot_count for band in protected)
        text_slots = expected_lines - protected_slots
        if text_slots < 0:
            raise ValueError(
                "Protected bands consume more slots than expected lines: "
                f"{protected_slots} > {expected_lines}"
            )

        regions = self._allocate_text_slots(
            binary,
            protected,
            text_slots,
            expected_lines,
        )
        detected: list[_DetectedBand] = []

        for region in regions:
            if region.slots <= 0:
                continue
            region_boxes = split_by_valleys(
                grey[region.top : region.bottom, :],
                binary[region.top : region.bottom, :],
                region.slots,
                self.detection.padding,
            )
            detected.extend(
                _DetectedBand(
                    box={
                        "left": box["left"],
                        "top": box["top"] + region.top,
                        "right": box["right"],
                        "bottom": box["bottom"] + region.top,
                    }
                )
                for box in region_boxes
            )

        _h, w = binary.shape
        for band in protected:
            detected.append(
                _DetectedBand(
                    box={
                        "left": 0,
                        "top": band.top,
                        "right": w,
                        "bottom": band.bottom,
                    },
                    is_sura=band.kind == "sura_header",
                    is_basmala=band.kind == "basmala",
                    slot_count=band.slot_count,
                )
            )

        detected.sort(key=lambda band: (band.box["top"], band.box["bottom"]))
        return detected

    def _allocate_text_slots(
        self,
        binary: np.ndarray,
        protected: list[ProtectedBand],
        text_slots: int,
        expected_lines: int,
    ) -> list[_TextRegion]:
        min_region_height = max(1, round(binary.shape[0] / expected_lines * 0.75))
        regions = self._content_regions(binary, protected, min_region_height)
        if text_slots == 0:
            return regions
        if not regions:
            raise ValueError("Protected bands left no text regions to split")
        if len(regions) > text_slots:
            raise ValueError(
                f"More text regions than remaining slots: {len(regions)} > {text_slots}"
            )

        total_height = sum(region.content_height for region in regions)
        raw_slots = [
            region.content_height / max(1, total_height) * text_slots
            for region in regions
        ]
        slots = [max(1, int(np.round(raw))) for raw in raw_slots]

        # while sum(slots) < text_slots:
        #     idx = max(
        #         range(len(regions)),
        #         key=lambda i: (raw_slots[i] - np.floor(raw_slots[i]), raw_slots[i]),
        #     )
        #     slots[idx] += 1

        # while sum(slots) > text_slots:
        #     candidates = [i for i, value in enumerate(slots) if value > 1]
        #     if not candidates:
        #         break
        #     idx = min(
        #         candidates,
        #         key=lambda i: (raw_slots[i] - np.floor(raw_slots[i]), raw_slots[i]),
        #     )
        #     slots[idx] -= 1

        for region, slot_count in zip(regions, slots, strict=True):
            region.slots = slot_count
            logger.info(
                "  Text region y=%d..%d content_h=%d slots=%d",
                region.top,
                region.bottom,
                region.content_height,
                region.slots,
            )
        return regions

    @staticmethod
    def _content_regions(
        binary: np.ndarray,
        protected: list[ProtectedBand],
        min_region_height: int,
    ) -> list[_TextRegion]:
        h = binary.shape[0]
        ranges: list[tuple[int, int]] = []
        cursor = 0
        for band in sorted(protected, key=lambda item: item.top):
            top = max(0, min(h, band.top))
            bottom = max(0, min(h, band.bottom))
            if top > cursor:
                ranges.append((cursor, top))
            cursor = max(cursor, bottom)
        if cursor < h:
            ranges.append((cursor, h))

        regions: list[_TextRegion] = []
        for top, bottom in ranges:
            result = find_content_bbox(binary[top:bottom, :])
            if result is None:
                continue
            _x, cy, _w, ch = result
            if ch < min_region_height:
                logger.info(
                    "  Ignoring tiny text region y=%d..%d content_h=%d",
                    top + cy,
                    top + cy + ch,
                    ch,
                )
                continue
            regions.append(
                _TextRegion(
                    top=top + cy,
                    bottom=top + cy + ch,
                    content_height=ch,
                )
            )
        return regions

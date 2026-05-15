"""Data structures for the page processing pipeline.

Provides the core context objects that flow through every stage of processing:
PageContext (per-page), LineResult, SegmentResult, BBox, and QuranTracker
(cross-page sura/aya state).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image


@dataclass
class BBox:
    """Bounding box in pixel coordinates."""

    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    def as_xywh(self) -> dict[str, int]:
        """Return dict with x, y, w, h keys."""
        return {"x": self.left, "y": self.top, "w": self.width, "h": self.height}

    def as_slice(self) -> tuple[slice, slice]:
        """Return numpy-compatible (row_slice, col_slice) for zero-copy views."""
        return (slice(self.top, self.bottom), slice(self.left, self.right))


@dataclass
class SegmentResult:
    """An aya segment within a detected line."""

    bbox: BBox
    has_separator: bool
    sura_number: int | None = None
    aya_number: int | None = None
    is_continuation: bool = False


@dataclass
class LineResult:
    """A detected text line with its classification and aya segments."""

    bbox: BBox
    line_index: int  # 1-based index within the page
    slot_count: int = 1
    is_sura: bool = False
    is_basmala: bool = False
    segments: list[SegmentResult] = field(default_factory=list)
    # Tight bounding box of actual content — computed once, cached
    content_bbox: BBox | None = None
    # Populated by QuranTracker for sura headers
    sura_number: int | None = None
    sura_name: str | None = None
    sura_transliteration: str | None = None


@dataclass
class PageContext:
    """Complete processing context for a single page.

    Created fresh for each page, accumulates results from every pipeline stage,
    and is discarded after the page is fully processed.

    Numpy array accessors return zero-copy views (slices), not copies.
    PIL image crops are deferred to export time.
    """

    image: Image.Image
    grey: np.ndarray
    binary: np.ndarray
    filename: str
    page_index: int
    crop_box: BBox | None = None
    lines: list[LineResult] = field(default_factory=list)

    # -- Zero-copy array accessors ------------------------------------

    def cropped_grey(self) -> np.ndarray:
        """Grey array for the crop region (numpy view)."""
        if self.crop_box is None:
            return self.grey
        rows, cols = self.crop_box.as_slice()
        return self.grey[rows, cols]

    def cropped_binary(self) -> np.ndarray:
        """Binary array for the crop region (numpy view)."""
        if self.crop_box is None:
            return self.binary
        rows, cols = self.crop_box.as_slice()
        return self.binary[rows, cols]

    def line_grey(self, line: LineResult) -> np.ndarray:
        """Grey array for a specific line (numpy view)."""
        rows, cols = line.bbox.as_slice()
        return self.grey[rows, cols]

    def line_binary(self, line: LineResult) -> np.ndarray:
        """Binary array for a specific line (numpy view)."""
        rows, cols = line.bbox.as_slice()
        return self.binary[rows, cols]

    def line_image(self, line: LineResult) -> Image.Image:
        """PIL crop of a line — deferred, only call at export time."""
        b = line.bbox
        return self.image.crop((b.left, b.top, b.right, b.bottom))


@dataclass
class QuranTracker:
    """Global state tracking sura/aya position across all pages.

    Created once per pipeline run (initialized from ExportConfig),
    passed through every page, and updated as sura headers and aya
    separators are encountered.
    """

    current_sura: int = 1
    current_aya: int = 1
    pending_basmala: bool = False

    def advance_sura(self) -> None:
        """Move to the next sura, reset aya to 1, flag basmala check."""
        self.current_sura += 1
        self.current_aya = 1
        self.pending_basmala = True

    def advance_aya(self) -> None:
        """Move to the next aya within the current sura."""
        self.current_aya += 1

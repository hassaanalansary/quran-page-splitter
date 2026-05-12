"""Shared configuration dataclasses for the line-cutter pipeline."""

from dataclasses import dataclass


@dataclass
class CropConfig:
    """A data class for the coordinates of the content of the page without the borders
    It is used, mainly, for cropping the border from the page.
    """

    x: int
    y: int
    w: int
    h: int

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.w, self.h)


@dataclass
class ProcessingConfig:
    """Configuration settings for page processing.

    Attributes:
        alternate_horizontal_margin: Specifies if horizontal margins alternate between
            opposing pages. When True, accounts for Mushafs where the left margin of a
            right-side page mirrors the right margin of a left-side page.
    """

    alternate_horizontal_margin: bool = False


@dataclass
class DetectionConfig:
    """A data class that holds the main parameters required for splitting the page
    into lines.

    Attributes:
        gap_threshold: The threshold for detecting gaps between lines.
        min_line_height: The minimum height of a line (pixels), from UI or calibration.
        padding: The padding around the detected lines.
        min_line_height_floor: Values below this are never passed to line detection.
            Set from calibration (typical line height minus margin); default 80 for
            high-res mushafs. Phase C recovery does not lower min_line_height.
    """

    gap_threshold: float = 0.03
    min_line_height: int = 80
    padding: int = 4
    min_line_height_floor: int = 80

    def effective_min_line_height(self) -> int:
        """Minimum band height actually used by ``get_line_boxes``."""
        return max(self.min_line_height, self.min_line_height_floor)

    def as_dict(self) -> dict:
        return {
            "gap_threshold": self.gap_threshold,
            "min_line_height": self.effective_min_line_height(),
            "padding": self.padding,
        }


@dataclass
class ClassifierConfig:
    """A data class that holds the main parameters
    for classifying a line as a sura name.

    Attributes:
        height_factor: The factor to multiply the line height by to get the
            threshold for classifying a line as a sura name.
        match_threshold: The threshold for matching the sura name.
    """

    height_factor: float = 1.5
    match_threshold: float = 0.8


@dataclass
class ExportConfig:
    """Configuration for what the pipeline exports.

    Attributes:
        export_images: Whether to save cropped line/segment PNGs.
        export_coordinates: Whether to collect bounding-box coordinate data.
        start_sura: Sura number at the start of processing (1-based).
        start_aya: Aya number at the start of processing (1-based).
        expected_lines: Expected number of detected lines per page (sura/basmala bands count).
    """

    export_images: bool = True
    export_coordinates: bool = False
    start_sura: int = 1
    start_aya: int = 1
    expected_lines: int = 15

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
    """Parameters for line detection.

    Attributes:
        padding: Pixel margin added around each detected line box.
        sura_header_slots: Number of layout slots consumed by one sura header
            band. The header is still exported as one crop.
        sura_header_threshold: Template match threshold for pre-split sura
            header detection.
        basmala_threshold: Template match threshold for optional pre-split
            basmala detection.
        max_sura_headers: Maximum sura headers expected on one page.
    """

    padding: int = 4
    sura_header_slots: int = 1
    sura_header_threshold: float = 0.60
    basmala_threshold: float = 0.70
    max_sura_headers: int = 3


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
        expected_lines: Expected number of detected lines per page (sura/basmala
            bands count).
    """

    export_images: bool = True
    export_coordinates: bool = False
    start_sura: int = 1
    start_aya: int = 1
    expected_lines: int = 15

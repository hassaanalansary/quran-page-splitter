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
        min_line_height: The minimum height of a line.
        padding: The padding around the detected lines.
    """

    gap_threshold: float = 0.03
    min_line_height: int = 20
    padding: int = 4

    def as_dict(self) -> dict:
        return {
            "gap_threshold": self.gap_threshold,
            "min_line_height": self.min_line_height,
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

"""Shared configuration dataclasses for the line-cutter pipeline."""

from dataclasses import dataclass


@dataclass
class CropConfig:
    x: int
    y: int
    w: int
    h: int

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.w, self.h)


@dataclass
class ProcessingConfig:
    alternate_horizontal_margin: bool = False


@dataclass
class DetectionConfig:
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
    height_factor: float = 1.5
    match_threshold: float = 0.8

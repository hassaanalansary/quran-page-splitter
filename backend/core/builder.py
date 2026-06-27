"""Pipeline factory: builds configs and assembles the pipeline.

Templates are loaded into PIL images by the caller (the API service layer);
this module stays free of any web-framework or storage concerns.
"""

from pathlib import Path

from core.aya_separator import AyaSeparatorProcessor
from core.config import CropConfig, DetectionConfig, ExportConfig, ProcessingConfig
from core.line_detector import LineDetector
from core.page_processor import PageProcessor
from core.pipeline import Pipeline
from core.protected_bands import ProtectedBandLocator


def init_configs(
    x: int,
    y: int,
    w: int,
    h: int,
    padding: int,
    alternate_horizontal_margin: bool,
    sura_header_slots: int = 1,
    sura_header_threshold: float = 0.60,
    max_sura_headers: int = 3,
) -> tuple[CropConfig, DetectionConfig, ProcessingConfig]:
    """Initialize the (crop, detection, processing) configs for the pipeline."""
    return (
        CropConfig(x=x, y=y, w=w, h=h),
        DetectionConfig(
            padding=padding,
            sura_header_slots=sura_header_slots,
            sura_header_threshold=sura_header_threshold,
            max_sura_headers=max_sura_headers,
        ),
        ProcessingConfig(alternate_horizontal_margin=alternate_horizontal_margin),
    )


def build_pipeline(
    crop_cfg: CropConfig,
    det_cfg: DetectionConfig,
    proc_cfg: ProcessingConfig,
    export_cfg: ExportConfig,
    aya_processor: AyaSeparatorProcessor,
    results_dir: Path,
    protected_locator: ProtectedBandLocator | None = None,
) -> Pipeline:
    """Assemble the detector, page processor, and pipeline from the given configs."""
    detector = LineDetector(
        crop=crop_cfg,
        detection=det_cfg,
        processing=proc_cfg,
        protected_locator=protected_locator,
    )
    processor = PageProcessor(
        detector=detector,
        results_dir=results_dir,
        aya_separator=aya_processor,
    )
    return Pipeline(processor=processor, export_config=export_cfg)

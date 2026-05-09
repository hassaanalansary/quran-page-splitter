import io
from pathlib import Path

from PIL import Image

from core.aya_separator import AyaSeparatorProcessor
from core.classifier import SuraClassifier
from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.line_detector import LineDetector
from core.page_processor import PageProcessor
from core.pipeline import Pipeline


def init_configs(
    x: int,
    y: int,
    w: int,
    h: int,
    gap_threshold: float,
    min_line_height: int,
    padding: int,
    alternate_horizontal_margin: bool,
) -> tuple[CropConfig, DetectionConfig, ProcessingConfig]:
    """
    Initialize the configs for the pipeline.
    Returns a tuple of (crop_config, detection_config, processing_config)
    """
    return (
        CropConfig(x=x, y=y, w=w, h=h),
        DetectionConfig(
            gap_threshold=gap_threshold,
            min_line_height=min_line_height,
            padding=padding,
        ),
        ProcessingConfig(alternate_horizontal_margin=alternate_horizontal_margin),
    )


async def prepare_template(  # type: ignore[no-untyped-def]
    template,
    file_name: str,
    results_dir: Path = Path("results"),
) -> Image.Image:

    # load the data from the request
    template_data = await template.read()

    # specify the path of the file
    template_path = results_dir / file_name

    # write the data to the file
    template_path.write_bytes(template_data)

    # load the image to memory
    template_image = Image.open(io.BytesIO(template_data))
    template_image.load()

    return template_image


def build_pipeline(
    crop_cfg: CropConfig,
    det_cfg: DetectionConfig,
    proc_cfg: ProcessingConfig,
    classifier: SuraClassifier,
    aya_processor: AyaSeparatorProcessor,
    results_dir: Path,
) -> Pipeline:
    """
    Builds the pipeline from the given configs and templates.
    Returns the pipeline.
    """
    detector = LineDetector(crop=crop_cfg, detection=det_cfg, processing=proc_cfg)
    processor = PageProcessor(
        detector=detector,
        results_dir=results_dir,
        classifier=classifier,
        aya_separator=aya_processor,
    )
    return Pipeline(processor=processor)

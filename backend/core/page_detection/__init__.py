"""The page engine: a mushaf page in, its lines and aya segments out.

    from core.page_detection import build_pipeline, init_configs

    pipeline = build_pipeline(crop_cfg=..., det_cfg=..., ...)
    result = pipeline.run(images, filenames=[...])

Given a rendered page it crops the text column, protects the sura-header bands,
splits what is left into lines, finds the aya ornaments on each, and carries a
sura/aya cursor across the whole batch so every segment comes out addressed. The
answer is plain dicts of coordinates; it writes nothing unless asked for a file.

    config.py               the knobs a run is given
    context.py              BBox / LineResult / SegmentResult, PageContext, and the
                            QuranTracker that walks the sura-aya cursor
    imaging (elsewhere)     binarising, content boxes, template matching
    line_cutter.py          one column of ink → horizontal bands, by valley
    sura_header.py          where the decorated sura titles are, so lines avoid them
    line_detector.py        bands + headers → this page's lines
    aya_separator.py        ornaments on a line → its aya segments
    coordinate_exporter.py  the result as coordinates, numbered by the tracker
    page_processor.py       one page, start to finish
    pipeline.py             every page, with cancellation and progress
    builder.py              wire the above together from a run's settings

**One shared ``PageContext`` per page** is what makes this one package rather than
five. Each stage reads what the last one wrote onto the context and adds its own,
which is why the modules are not separable engines the way ``word_boundary`` is —
that one is handed its input and answers, touching nothing shared.

Steerable from outside without knowing anything about the web layer: the caller
passes ``should_cancel`` to stop between pages and ``on_page_start`` /
``on_page_done`` to watch and persist. See ``api.services.processing``.
"""

from core.page_detection.aya_separator import AyaSeparatorConfig, AyaSeparatorProcessor
from core.page_detection.builder import build_pipeline, init_configs
from core.page_detection.config import CropConfig, DetectionConfig, ExportConfig, ProcessingConfig
from core.page_detection.context import BBox, LineResult, PageContext, QuranTracker, SegmentResult
from core.page_detection.coordinate_exporter import collect_page_coordinates, save_json, track_positions
from core.page_detection.line_cutter import split_by_valleys
from core.page_detection.line_detector import LineDetector
from core.page_detection.page_processor import (
    STATUS_LINE_COUNT_MISMATCH,
    STATUS_NO_LINES,
    PageProcessor,
    create_context,
    is_line_geometry_failure,
)
from core.page_detection.pipeline import PageOutcome, Pipeline
from core.page_detection.sura_header import SuraHeaderLocator, SuraHeaderSpec

__all__ = [
    "STATUS_LINE_COUNT_MISMATCH",
    "STATUS_NO_LINES",
    "AyaSeparatorConfig",
    "AyaSeparatorProcessor",
    "BBox",
    "CropConfig",
    "DetectionConfig",
    "ExportConfig",
    "LineDetector",
    "LineResult",
    "PageContext",
    "PageOutcome",
    "PageProcessor",
    "Pipeline",
    "ProcessingConfig",
    "QuranTracker",
    "SegmentResult",
    "SuraHeaderLocator",
    "SuraHeaderSpec",
    "build_pipeline",
    "collect_page_coordinates",
    "create_context",
    "init_configs",
    "is_line_geometry_failure",
    "save_json",
    "split_by_valleys",
    "track_positions",
]

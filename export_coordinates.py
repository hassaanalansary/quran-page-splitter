"""CLI entry point for exporting aya coordinates as JSON.

Usage:
    uv run export_coordinates.py pages_dir/ output.json \
        --sura-template sura.png \
        --aya-template aya.png \
        --crop-x 330 --crop-y 300 --crop-w 1844 --crop-h 2860 \
        --start-sura 2 --start-aya 6 \
        --start-page 3 \
        --gap-threshold 0.03 --min-line-height 20 --padding 4 \
        --alternate-margins
"""

import argparse
from pathlib import Path

from PIL import Image

from core.aya_separator import AyaSeparatorProcessor
from core.classifier import SuraClassifier
from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.coordinate_exporter import (
    CoordinateExporter,
    save_json,
    setup_export_logging,
)
from core.line_detector import LineDetector


def main():
    parser = argparse.ArgumentParser(
        description="Export aya bounding-box coordinates from Mushaf page images."
    )

    # Positional
    parser.add_argument(
        "pages_dir",
        type=str,
        help="Directory containing page images (sorted by filename).",
    )
    parser.add_argument(
        "output",
        type=str,
        default="output.json",
        help="Output JSON file path.",
    )

    # Templates
    parser.add_argument(
        "--sura-template",
        type=str,
        required=True,
        default="sura_name.png",
        help="Path to sura name template image.",
    )
    parser.add_argument(
        "--aya-template",
        type=str,
        required=True,
        default="aya_separator.png",
        help="Path to aya separator template image.",
    )

    # Crop
    parser.add_argument("--crop-x", type=int, required=True)
    parser.add_argument("--crop-y", type=int, required=True)
    parser.add_argument("--crop-w", type=int, required=True)
    parser.add_argument("--crop-h", type=int, required=True)

    # Detection
    parser.add_argument("--gap-threshold", type=float, default=0.03)
    parser.add_argument("--min-line-height", type=int, default=20)
    parser.add_argument("--padding", type=int, default=4)

    # Quran position
    parser.add_argument(
        "--start-sura",
        type=int,
        default=2,
        help="Sura number at the start of processing (default: 2).",
    )
    parser.add_argument(
        "--start-aya",
        type=int,
        default=6,
        help="Aya number at the start of processing (default: 6).",
    )
    parser.add_argument(
        "--start-page",
        type=int,
        default=3,
        help="First page to process; earlier pages are skipped (default: 3).",
    )

    # Processing
    parser.add_argument(
        "--alternate-margins",
        action="store_true",
        help="Mirror crop horizontally on every other page.",
    )

    args = parser.parse_args()

    pages_dir = Path(args.pages_dir)
    output_path = Path(args.output)

    if not pages_dir.is_dir():
        print(f"Error: '{pages_dir}' is not a directory.")
        return

    # Set up logging — writes detailed log alongside the JSON output
    log_path = output_path.with_suffix(".log")
    setup_export_logging(log_path)
    print(f"📝 Log file: {log_path}")

    # Load templates
    sura_template = Image.open(args.sura_template)
    sura_template.load()

    aya_template = Image.open(args.aya_template)
    aya_template.load()

    # Build configs
    crop_cfg = CropConfig(
        x=args.crop_x, y=args.crop_y, w=args.crop_w, h=args.crop_h
    )
    det_cfg = DetectionConfig(
        gap_threshold=args.gap_threshold,
        min_line_height=args.min_line_height,
        padding=args.padding,
    )
    proc_cfg = ProcessingConfig(
        alternate_horizontal_margin=args.alternate_margins
    )

    # Build components
    detector = LineDetector(crop=crop_cfg, detection=det_cfg, processing=proc_cfg)
    classifier = SuraClassifier(template=sura_template)
    aya_processor = AyaSeparatorProcessor(template=aya_template)

    # Run export
    exporter = CoordinateExporter(
        detector=detector,
        classifier=classifier,
        aya_separator=aya_processor,
        start_sura=args.start_sura,
        start_aya=args.start_aya,
    )

    result = exporter.export(pages_dir, start_page=args.start_page)

    # Save JSON
    save_json(result, output_path)
    print(f"\n✅ Export complete → {output_path}")
    print(f"   Pages processed: {result.get('pages_processed', 0)}")
    print(f"   Ended at Sura #{result.get('end_sura')}, Aya {result.get('end_aya')}")


if __name__ == "__main__":
    main()

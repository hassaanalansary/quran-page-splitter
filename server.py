# ruff: noqa: B008
"""FastAPI server — builds the pipeline from HTTP form data and runs it."""

import logging
import os
import shutil
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from core.aya_separator import AyaSeparatorProcessor
from core.builder import build_pipeline, init_configs, prepare_template
from core.classifier import SuraClassifier
from core.calibration import run_nominal_calibration
from core.config import CropConfig, ExportConfig, ProcessingConfig
from core.quran_metadata import SURAS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Line Cutter Server")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_index():  # type: ignore[no-untyped-def]
    index_path = Path("index.html")
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    return index_path.read_text(encoding="utf-8")


@app.get("/api/suras")
async def list_suras():  # type: ignore[no-untyped-def]
    """Expose sura list for the frontend (Arabic display name, numeric value)."""
    return [
        {
            "number": s.number,
            "name": s.name,
            "transliteration": s.transliteration,
            "aya_count": s.aya_count,
        }
        for s in SURAS
    ]


@app.post("/upload/")
async def upload_images(  # type: ignore[no-untyped-def]
    images: list[UploadFile] = File(...),
    sura_name: UploadFile = File(...),
    aya_separator: UploadFile = File(...),
    crop_x: int = Form(...),
    crop_y: int = Form(...),
    crop_w: int = Form(...),
    crop_h: int = Form(...),
    gap_threshold: float = Form(0.03),
    min_line_height: int = Form(80),
    padding: int = Form(4),
    min_line_height_floor: int = Form(80),
    alternate_horizontal_margin: bool = Form(False),
    export_images: bool = Form(True),
    export_coordinates: bool = Form(False),
    start_sura: int = Form(1),
    start_aya: int = Form(1),
    expected_lines: int = Form(15),
):
    if crop_w <= 0 or crop_h <= 0:
        raise HTTPException(status_code=400, detail="Invalid crop dimensions")
    if expected_lines < 1:
        raise HTTPException(
            status_code=400, detail="expected_lines must be at least 1"
        )
    if min_line_height_floor < 1:
        raise HTTPException(
            status_code=400, detail="min_line_height_floor must be at least 1"
        )

    # Clean the output directory for new request
    results_dir = Path("results")
    if os.path.exists(results_dir):
        shutil.rmtree(results_dir)
    os.makedirs(results_dir)

    # Build configs
    crop_cfg, det_cfg, proc_cfg = init_configs(
        crop_x,
        crop_y,
        crop_w,
        crop_h,
        gap_threshold,
        min_line_height,
        padding,
        alternate_horizontal_margin,
        min_line_height_floor,
    )

    export_cfg = ExportConfig(
        export_images=export_images,
        export_coordinates=export_coordinates,
        start_sura=start_sura,
        start_aya=start_aya,
        expected_lines=expected_lines,
    )

    # validate the templates
    try:
        # Load sura template and build classifier
        sura_template = await prepare_template(sura_name, "sura_name.png", results_dir)

        # Load aya separator template and build processor
        aya_template = await prepare_template(
            aya_separator, "aya_separator.png", results_dir
        )

    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid template image: {e}"
        ) from e

    # Build pipeline
    pipeline = build_pipeline(
        crop_cfg=crop_cfg,
        det_cfg=det_cfg,
        proc_cfg=proc_cfg,
        export_cfg=export_cfg,
        classifier=SuraClassifier(template=sura_template),
        aya_processor=AyaSeparatorProcessor(template=aya_template),
        results_dir=results_dir,
    )

    images_data = [(await f.read(), f.filename or "unknown") for f in images]
    return pipeline.run(images_data)


@app.post("/calibrate/")
async def calibrate(  # type: ignore[no-untyped-def]
    image: UploadFile = File(...),
    crop_x: int = Form(...),
    crop_y: int = Form(...),
    crop_w: int = Form(...),
    crop_h: int = Form(...),
    expected_lines: int = Form(15),
    padding: int = Form(4),
    min_line_height_floor: int = Form(80),
    alternate_horizontal_margin: bool = Form(False),
    nominal_height_margin_pct: float = Form(0.08),
    verify_on_cropped_unclean: int = Form(1),
):
    """One sura-free page: clean → height/N → projection gap; writes debug under results/calibration/."""
    if crop_w <= 0 or crop_h <= 0:
        raise HTTPException(status_code=400, detail="Invalid crop dimensions")
    if expected_lines < 1:
        raise HTTPException(
            status_code=400, detail="expected_lines must be at least 1"
        )
    if min_line_height_floor < 1:
        raise HTTPException(
            status_code=400, detail="min_line_height_floor must be at least 1"
        )
    if not 0.0 <= nominal_height_margin_pct < 0.95:
        raise HTTPException(
            status_code=400,
            detail="nominal_height_margin_pct must be in [0, 0.95)",
        )

    crop_cfg = CropConfig(x=crop_x, y=crop_y, w=crop_w, h=crop_h)
    proc_cfg = ProcessingConfig(
        alternate_horizontal_margin=alternate_horizontal_margin
    )
    raw = await image.read()
    fn = image.filename or "calibration.png"
    export_root = Path("results") / "calibration"
    export_root.mkdir(parents=True, exist_ok=True)

    return run_nominal_calibration(
        raw,
        fn,
        crop_cfg,
        proc_cfg,
        expected_lines,
        padding,
        min_line_height_floor,
        nominal_height_margin_pct,
        export_root,
        verify_on_cropped_unclean=bool(verify_on_cropped_unclean),
    )


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)

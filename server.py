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
from core.config import ExportConfig

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
    min_line_height: int = Form(20),
    padding: int = Form(4),
    alternate_horizontal_margin: bool = Form(False),
    export_images: bool = Form(True),
    export_coordinates: bool = Form(False),
    start_sura: int = Form(1),
    start_aya: int = Form(1),
):
    if crop_w <= 0 or crop_h <= 0:
        raise HTTPException(status_code=400, detail="Invalid crop dimensions")

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
    )

    export_cfg = ExportConfig(
        export_images=export_images,
        export_coordinates=export_coordinates,
        start_sura=start_sura,
        start_aya=start_aya,
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


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)

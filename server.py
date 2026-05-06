"""FastAPI server — builds the pipeline from HTTP form data and runs it."""

import os
import shutil
import logging
from pathlib import Path
from typing import List

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
import io

from core.config import CropConfig, DetectionConfig, ProcessingConfig
from core.line_detector import LineDetector
from core.classifier import SuraClassifier
from core.page_processor import PageProcessor
from core.pipeline import Pipeline
from core.aya_separator import AyaSeparatorProcessor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Line Cutter Server")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = Path("index.html")
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    return index_path.read_text(encoding="utf-8")


@app.post("/upload/")
async def upload_images(
    images: List[UploadFile] = File(...),
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
):
    if crop_w <= 0 or crop_h <= 0:
        raise HTTPException(status_code=400, detail="Invalid crop dimensions")

    # start clean for new request
    results_dir = Path("results")
    if os.path.exists(results_dir):
        shutil.rmtree(results_dir)
    os.makedirs(results_dir)

    # Build configs
    crop_cfg = CropConfig(x=crop_x, y=crop_y, w=crop_w, h=crop_h)
    proc_cfg = ProcessingConfig(alternate_horizontal_margin=alternate_horizontal_margin)
    det_cfg = DetectionConfig(
        gap_threshold=gap_threshold, min_line_height=min_line_height, padding=padding
    )

    # Load sura template and build classifier
    sura_name_data = await sura_name.read()
    sura_name_path = results_dir / "sura_name.png"
    sura_name_path.write_bytes(sura_name_data)
    try:
        sura_template = Image.open(io.BytesIO(sura_name_data))
        sura_template.load()  # Force validation
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid sura template image: {e}")
    classifier = SuraClassifier(template=sura_template)

    # Save and validate aya separator
    aya_data = await aya_separator.read()
    aya_path = results_dir / (aya_separator.filename or "aya_separator.png")
    aya_path.write_bytes(aya_data)
    try:
        aya_template = Image.open(io.BytesIO(aya_data))
        aya_template.load()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid aya separator image: {e}")
    aya_processor = AyaSeparatorProcessor(template=aya_template)

    # Build pipeline
    detector = LineDetector(crop=crop_cfg, detection=det_cfg, processing=proc_cfg)
    processor = PageProcessor(
        detector=detector,
        results_dir=results_dir,
        classifier=classifier,
        aya_separator=aya_processor,
    )
    pipeline = Pipeline(processor=processor)

    images_data = [(await f.read(), f.filename or "unknown") for f in images]
    return {"status": "completed", "results": pipeline.run(images_data)}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)

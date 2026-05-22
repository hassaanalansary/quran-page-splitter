# ruff: noqa: B008
"""FastAPI server — builds the pipeline from HTTP form data and runs it."""

import logging
import os
import shutil
from pathlib import Path

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from core.aya_separator import AyaSeparatorConfig, AyaSeparatorProcessor
from core.builder import build_pipeline, init_configs, prepare_template
from core.classifier import SuraClassifier
from core.config import ExportConfig
from core.protected_bands import IgnoreRect, ProtectedBandLocator
from core.quran_metadata import SURAS
from core.review import (
    CORRECTED_RESULTS_JSON,
    PAGES_DIR,
    RESULTS_JSON,
    load_review_results,
    re_export_corrected_images,
    resolve_page_copy,
    review_status,
    save_corrected_results,
)

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


@app.get("/review", response_class=HTMLResponse)
async def serve_review():  # type: ignore[no-untyped-def]
    review_path = Path("review.html")
    if not review_path.exists():
        raise HTTPException(status_code=404, detail="review.html not found")
    return review_path.read_text(encoding="utf-8")


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


@app.get("/api/review/status")
async def get_review_status():  # type: ignore[no-untyped-def]
    return review_status()


@app.get("/api/review/results")
async def get_review_results(  # type: ignore[no-untyped-def]
    source: str = Query("latest", pattern="^(latest|original)$"),
):
    try:
        data, path = load_review_results(source)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="results.json not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"source_path": str(path), "data": data}


@app.get("/api/review/pages/{page_image_filename}")
async def get_review_page(page_image_filename: str):  # type: ignore[no-untyped-def]
    try:
        path = resolve_page_copy(page_image_filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Page image not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return FileResponse(path)


@app.post("/api/review/save")
async def save_review_results(  # type: ignore[no-untyped-def]
    payload: dict = Body(...),
):
    try:
        corrected = save_corrected_results(payload)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "status": "saved",
        "path": str(CORRECTED_RESULTS_JSON),
        "data": corrected,
    }


@app.post("/api/review/re-export")
async def re_export_review_images():  # type: ignore[no-untyped-def]
    if not CORRECTED_RESULTS_JSON.exists():
        raise HTTPException(
            status_code=404,
            detail="corrected_results.json not found. Save corrections first.",
        )
    try:
        summary = re_export_corrected_images()
    except (FileNotFoundError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "exported", **summary}


@app.post("/upload/")
async def upload_images(  # type: ignore[no-untyped-def]
    images: list[UploadFile] = File(...),
    sura_header: UploadFile | None = File(None),
    sura_name: UploadFile | None = File(None),
    aya_separator: UploadFile = File(...),
    crop_x: int = Form(...),
    crop_y: int = Form(...),
    crop_w: int = Form(...),
    crop_h: int = Form(...),
    padding: int = Form(4),
    sura_header_slots: int = Form(1),
    sura_header_threshold: float = Form(0.60),
    max_sura_headers: int = Form(3),
    sura_header_ignore_x: int | None = Form(None),
    sura_header_ignore_y: int | None = Form(None),
    sura_header_ignore_w: int | None = Form(None),
    sura_header_ignore_h: int | None = Form(None),
    aya_separator_ignore_x: int | None = Form(None),
    aya_separator_ignore_y: int | None = Form(None),
    aya_separator_ignore_w: int | None = Form(None),
    aya_separator_ignore_h: int | None = Form(None),
    alternate_horizontal_margin: bool = Form(False),
    export_images: bool = Form(True),
    export_coordinates: bool = Form(False),
    start_sura: int = Form(1),
    start_aya: int = Form(1),
    expected_lines: int = Form(15),
    match_threshold: float = Form(0.50),
):
    if crop_w <= 0 or crop_h <= 0:
        raise HTTPException(status_code=400, detail="Invalid crop dimensions")
    if expected_lines < 1:
        raise HTTPException(status_code=400, detail="expected_lines must be at least 1")
    if sura_header_slots < 1:
        raise HTTPException(status_code=400, detail="sura_header_slots must be >= 1")
    if max_sura_headers < 1:
        raise HTTPException(status_code=400, detail="max_sura_headers must be >= 1")
    if not 0 <= sura_header_threshold <= 1:
        raise HTTPException(
            status_code=400, detail="sura_header_threshold must be 0..1"
        )
    if not 0 <= match_threshold <= 1:
        raise HTTPException(
            status_code=400, detail="match_threshold must be 0..1"
        )

    # Clean the output directory for new request
    results_dir = Path("results")
    if os.path.exists(results_dir):
        shutil.rmtree(results_dir)
    os.makedirs(results_dir)
    PAGES_DIR.mkdir(parents=True, exist_ok=True)
    for artifact_path in (RESULTS_JSON, CORRECTED_RESULTS_JSON):
        if artifact_path.exists():
            artifact_path.unlink()

    # Build configs
    crop_cfg, det_cfg, proc_cfg = init_configs(
        crop_x,
        crop_y,
        crop_w,
        crop_h,
        padding,
        alternate_horizontal_margin,
        sura_header_slots,
        sura_header_threshold,
        max_sura_headers,
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
        sura_upload = sura_header or sura_name
        if sura_upload is None:
            raise ValueError("Missing sura header template")

        # Load sura template and build classifier / pre-split locator
        sura_template = await prepare_template(
            sura_upload,
            "sura_header.png",
            results_dir,
        )

        # Load aya separator template and build processor
        aya_template = await prepare_template(
            aya_separator, "aya_separator.png", results_dir
        )

    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid template image: {e}"
        ) from e

    sura_ignore = _ignore_rect(
        sura_header_ignore_x,
        sura_header_ignore_y,
        sura_header_ignore_w,
        sura_header_ignore_h,
    )
    aya_ignore = _ignore_rect(
        aya_separator_ignore_x,
        aya_separator_ignore_y,
        aya_separator_ignore_w,
        aya_separator_ignore_h,
    )
    protected_locator = ProtectedBandLocator(
        sura_template,
        sura_header_ignore=sura_ignore,
        sura_header_slots=det_cfg.sura_header_slots,
        sura_header_threshold=det_cfg.sura_header_threshold,
        max_sura_headers=det_cfg.max_sura_headers,
    )

    # Build pipeline
    pipeline = build_pipeline(
        crop_cfg=crop_cfg,
        det_cfg=det_cfg,
        proc_cfg=proc_cfg,
        export_cfg=export_cfg,
        classifier=SuraClassifier(template=sura_template),
        aya_processor=AyaSeparatorProcessor(
            template=aya_template,
            config=AyaSeparatorConfig(match_threshold=match_threshold),
            ignore_rect=aya_ignore,
        ),
        results_dir=results_dir,
        protected_locator=protected_locator,
    )

    images_data = [(await f.read(), f.filename or "unknown") for f in images]
    return pipeline.run(images_data)


def _ignore_rect(
    x: int | None,
    y: int | None,
    w: int | None,
    h: int | None,
) -> IgnoreRect | None:
    if x is None or y is None or w is None or h is None:
        return None
    if w <= 0 or h <= 0:
        return None
    return IgnoreRect(x=x, y=y, w=w, h=h)


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)

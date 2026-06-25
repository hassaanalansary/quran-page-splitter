# ruff: noqa: B008
"""FastAPI server — builds the pipeline from HTTP form data and runs it."""

import logging
import os
import shutil
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from core.aya_separator import AyaSeparatorConfig, AyaSeparatorProcessor
from core.builder import build_pipeline, init_configs, prepare_template
from core.config import ExportConfig
from core.cut_review import (
    CUT_EDITS_JSON,
    LINE_CUT_RESULTS_JSON,
    cut_review_status,
    export_final_line_images,
    load_cut_review_results,
    save_cut_edits,
)
from core.protected_bands import IgnoreRect, ProtectedBandLocator
from core.quran_metadata import SURAS
from core.review import (
    CORRECTED_RESULTS_JSON,
    PAGES_DIR,
    RESULTS_JSON,
    load_review_results,
    resolve_page_copy,
    review_status,
    save_corrected_results,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
SPA_INDEX = FRONTEND_DIST / "index.html"
SPA_ASSETS = FRONTEND_DIST / "assets"

app = FastAPI(title="Line Cutter Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://localhost:5173",
        "http://localhost:8080",
        "https://quran-page-splitter.lovable.app",
        "https://quran-page-splitter-2.lovable.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=BACKEND_DIR / "static"), name="static")
app.mount("/assets", StaticFiles(directory=SPA_ASSETS, check_dir=False), name="spa-assets")


def serve_spa_index() -> FileResponse:
    if not SPA_INDEX.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "React frontend build not found. Run `npm install` and "
                "`npm run build` from the frontend directory before using "
                "FastAPI one-server mode."
            ),
        )
    return FileResponse(SPA_INDEX)


@app.get("/", include_in_schema=False)
async def redirect_to_upload():  # type: ignore[no-untyped-def]
    return RedirectResponse(url="/upload")


@app.get("/review", include_in_schema=False)
async def redirect_review():  # type: ignore[no-untyped-def]
    return RedirectResponse(url="/verify")


@app.get("/cut-review", include_in_schema=False)
@app.get("/line-review", include_in_schema=False)
async def redirect_cut_review():  # type: ignore[no-untyped-def]
    return RedirectResponse(url="/finalize")


@app.get("/upload", include_in_schema=False)
@app.get("/verify", include_in_schema=False)
@app.get("/finalize", include_in_schema=False)
async def serve_spa_route():  # type: ignore[no-untyped-def]
    return serve_spa_index()


@app.get("/api/suras")
async def list_suras() -> list[dict[str, int | str]]:  # type: ignore[no-untyped-def]
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
async def get_review_status():
    return review_status()


@app.get("/api/review/results")
async def get_review_results(  # type: ignore[no-untyped-def]
    source: str = Query("latest", pattern="^(latest|original)$"),
) -> dict[str, str | dict[str, Any]]:  # type: ignore[no-untyped-def]
    try:
        data, path = load_review_results(source)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="results.json not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"source_path": str(path), "data": data}  # type: ignore


@app.get("/api/review/pages/{page_image_filename}")
async def get_review_page(page_image_filename: str):  # type: ignore[no-untyped-def]
    try:
        path = resolve_page_copy(page_image_filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Page image not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return FileResponse(path)


@app.get("/api/cut-review/status")
async def get_cut_review_status():  # type: ignore[no-untyped-def]
    return cut_review_status()


@app.get("/api/cut-review/results")
async def get_cut_review_results():  # type: ignore[no-untyped-def]
    try:
        return load_cut_review_results()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="results.json not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/cut-review/save")
async def save_cut_review_edits(payload: dict = Body(...)):  # type: ignore[no-untyped-def]
    try:
        return save_cut_edits(payload)
    except (FileNotFoundError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/cut-review/export")
async def export_cut_review_images():  # type: ignore[no-untyped-def]
    try:
        return export_final_line_images()
    except (FileNotFoundError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    start_sura: int = Form(1),
    start_aya: int = Form(1),
    expected_lines: int = Form(15),
    match_threshold: float = Form(0.50),
    prefer_acceleration: bool = Form(True),
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
        raise HTTPException(status_code=400, detail="match_threshold must be 0..1")

    # Clean the output directory for new request
    results_dir = Path("results")
    if os.path.exists(results_dir):
        shutil.rmtree(results_dir)
    os.makedirs(results_dir)
    PAGES_DIR.mkdir(parents=True, exist_ok=True)
    for artifact_path in (
        RESULTS_JSON,
        CORRECTED_RESULTS_JSON,
        CUT_EDITS_JSON,
        LINE_CUT_RESULTS_JSON,
    ):
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
        export_images=False,
        export_coordinates=True,
        start_sura=start_sura,
        start_aya=start_aya,
        expected_lines=expected_lines,
    )

    # validate the templates
    try:
        sura_upload = sura_header or sura_name
        if sura_upload is None:
            raise ValueError("Missing sura header template")

        # Load sura template and build / pre-split locator
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
        prefer_acceleration=prefer_acceleration,
    )

    # Build pipeline
    pipeline = build_pipeline(
        crop_cfg=crop_cfg,
        det_cfg=det_cfg,
        proc_cfg=proc_cfg,
        export_cfg=export_cfg,
        aya_processor=AyaSeparatorProcessor(
            template=aya_template,
            config=AyaSeparatorConfig(match_threshold=match_threshold),
            ignore_rect=aya_ignore,
            prefer_acceleration=prefer_acceleration,
        ),
        results_dir=results_dir,
        protected_locator=protected_locator,
    )

    images_data = [(await f.read(), f.filename or "unknown") for f in images]
    return pipeline.run(images_data)


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa_fallback(full_path: str):  # type: ignore[no-untyped-def]
    if full_path.startswith(("api/", "upload/")):
        raise HTTPException(status_code=404, detail="Not found")
    return serve_spa_index()


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

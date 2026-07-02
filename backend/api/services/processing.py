"""Processing: assemble the engine pipeline from stored templates + request
settings, run it, and persist the resulting coordinates as Page/Line/Segment rows.

This is the only place the ORM and the pure ``core`` engine meet. The pipeline
runs outside the DB transaction; only the persistence step is transactional.
"""

import json
from pathlib import Path

from django.db import transaction
from django.db.models import Count
from ninja.errors import HttpError
from PIL import Image

from api import validators
from api.models import ActivityTypeChoices, Mushaf, Page, ProcessingRun, Template
from api.services import activity, coordinates, pdf
from core.aya_separator import AyaSeparatorConfig, AyaSeparatorProcessor
from core.builder import build_pipeline, init_configs
from core.config import ExportConfig
from core.sura_header import IgnoreRect, SuraHeaderLocator


def process(
    mushaf: Mushaf,
    *,
    page_range_start: int,
    page_range_end: int,
    start_sura: int,
    start_aya: int,
    bounds: dict,
    padding: int,
    expected_lines: int,
    sura_header_slots: int,
    sura_header_threshold: float,
    max_sura_headers: int,
    match_threshold: float,
    alternate_horizontal_margin: bool,
    prefer_acceleration: bool,
) -> dict:
    """Render + detect a logical page range, persist rows, and log a run."""
    validators.validate_page_range(mushaf, page_range_start, page_range_end)
    sura_template, aya_template = _required_templates(mushaf)

    crop_cfg, det_cfg, proc_cfg = init_configs(
        bounds["x"],
        bounds["y"],
        bounds["w"],
        bounds["h"],
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
    sura_header_locator = SuraHeaderLocator(
        _load_image(sura_template),
        ignore=_ignore_rect(sura_template.ignore_rects),
        slots=sura_header_slots,
        threshold=sura_header_threshold,
        max_sura_headers=max_sura_headers,
        prefer_acceleration=prefer_acceleration,
    )
    aya_processor = AyaSeparatorProcessor(
        template=_load_image(aya_template),
        config=AyaSeparatorConfig(match_threshold=match_threshold),
        ignore_rect=_ignore_rect(aya_template.ignore_rects),
        prefer_acceleration=prefer_acceleration,
    )

    page_numbers = list(range(page_range_start, page_range_end + 1))
    overrides = dict(
        Page.objects.filter(mushaf=mushaf, page_number__in=page_numbers).values_list("page_number", "source_pdf_page")
    )
    images_data = [
        (
            pdf.render_page(
                mushaf.pdf_file.path,
                pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, n, overrides.get(n)),
            ),
            f"{n}.png",
        )
        for n in page_numbers
    ]

    results_dir = Path(__file__).resolve().parents[2] / "tmp" / "processing"
    results_dir.mkdir(parents=True, exist_ok=True)

    pipeline = build_pipeline(
        crop_cfg=crop_cfg,
        det_cfg=det_cfg,
        proc_cfg=proc_cfg,
        export_cfg=export_cfg,
        aya_processor=aya_processor,
        results_dir=results_dir,
        sura_header_locator_locator=sura_header_locator,
    )
    output = pipeline.run(images_data)

    settings_used = {
        "padding": padding,
        "expected_lines": expected_lines,
        "sura_header_slots": sura_header_slots,
        "sura_header_threshold": sura_header_threshold,
        "max_sura_headers": max_sura_headers,
        "match_threshold": match_threshold,
        "alternate_horizontal_margin": alternate_horizontal_margin,
        "prefer_acceleration": prefer_acceleration,
        "start_sura": start_sura,
        "start_aya": start_aya,
        "bounds": bounds,
    }
    coord_pages = output.get("coordinates", {}).get("pages", [])

    with transaction.atomic():
        run = ProcessingRun.objects.create(
            mushaf=mushaf,
            settings=settings_used,
            page_range_start=page_range_start,
            page_range_end=page_range_end,
            status=output["status"],
            abort_info=json.dumps(output["abort_at"]) if output.get("abort_at") else "",
        )
        pages_saved = 0
        for page_number, coord_page in zip(page_numbers, coord_pages, strict=False):
            coordinates.write_coords_to_page(mushaf=mushaf, page_number=page_number, run=run, coord_page=coord_page)
            pages_saved += 1
        event = {
            "run_id": str(run.id),
            "run_number": ProcessingRun.objects.filter(mushaf=mushaf).count(),
            "status": output["status"],
            "pages_saved": pages_saved,
            "page_range_start": page_range_start,
            "page_range_end": page_range_end,
        }
        abort_at = output.get("abort_at")
        if isinstance(abort_at, dict) and abort_at.get("page_index") is not None:
            event["abort_page"] = page_range_start + abort_at["page_index"]
        activity.emit(mushaf, ActivityTypeChoices.RUN_FINISHED, event)

    return {
        "run_id": run.id,
        "status": output["status"],
        "pages_processed": output["pages_processed"],
        "start_sura": output["start_sura"],
        "start_aya": output["start_aya"],
        "end_sura": output["end_sura"],
        "end_aya": output["end_aya"],
        "results": output["results"],
        "abort_info": output.get("abort_at"),
    }


def list_runs(mushaf: Mushaf) -> list[dict]:
    """Processing-run history for a mushaf, newest first.

    ``run_number`` is assigned in chronological order (oldest = #1) so it stays
    stable regardless of display order; ``pages_saved`` is how many pages currently
    point at this run; ``abort_info`` is parsed back from its stored JSON string.
    """
    rows = list(
        mushaf.processing_runs.annotate(pages_saved=Count("pages"))
        .values(
            "id",
            "created_at",
            "status",
            "page_range_start",
            "page_range_end",
            "pages_saved",
            "settings",
            "abort_info",
        )
        .order_by("created_at")
    )
    serialized = [
        {
            "id": row["id"],
            "run_number": number,
            "created_at": row["created_at"],
            "status": row["status"],
            "page_range_start": row["page_range_start"],
            "page_range_end": row["page_range_end"],
            "pages_saved": row["pages_saved"],
            "settings": row["settings"],
            "abort_info": json.loads(row["abort_info"]) if row["abort_info"] else None,
        }
        for number, row in enumerate(rows, start=1)
    ]
    return serialized[::-1]


def _required_templates(mushaf: Mushaf) -> tuple[Template, Template]:
    by_type = {t.type: t for t in mushaf.templates.all()}
    try:
        return by_type["sura_header"], by_type["aya_separator"]
    except KeyError:
        raise HttpError(
            400,
            "Both sura_header and aya_separator templates are required before processing.",
        ) from None


def _load_image(template: Template) -> Image.Image:
    image = Image.open(template.image.path)
    image.load()
    return image


def _ignore_rect(data: dict) -> IgnoreRect | None:
    if not data:
        return None
    return IgnoreRect(x=data["x"], y=data["y"], w=data["w"], h=data["h"])

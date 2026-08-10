"""Processing: assemble the engine pipeline from stored templates + request
settings, run it, and persist the resulting coordinates as Page/Line/Segment rows.

This is the only place the ORM and the pure ``core`` engine meet.

The run is *steerable*: callers pass ``should_cancel`` to stop it between pages
and ``on_progress`` to watch it advance (see services/jobs.py, which binds both
to a background job). Two consequences shape the code below:

* Pages are rendered **lazily**, one at a time, from a single open PDF handle —
  so a cancel never pays for work it is about to throw away, and a 600-page run
  never holds 600 rendered pages in memory.
* The ``ProcessingRun`` row is created **up front** (status ``running``) so each
  page can be persisted in its own transaction the moment it lands. A cancelled
  or crashed run therefore keeps everything it got through.
"""

import json
import logging
import shutil
import uuid
from collections.abc import Callable, Iterable, Iterator
from datetime import datetime
from pathlib import Path

import fitz  # PyMuPDF
from django.conf import settings
from django.db import transaction
from django.db.models import Count
from ninja.errors import HttpError
from PIL import Image

from api import i18n, validators
from api.models import ActivityTypeChoices, Mushaf, Page, ProcessingRun, RunStatusChoices, Template
from api.services import activity, coordinates, pdf
from core.aya_separator import AyaSeparatorConfig, AyaSeparatorProcessor
from core.builder import build_pipeline, init_configs
from core.config import ExportConfig
from core.pipeline import PageOutcome, setup_file_logging, teardown_file_logging
from core.sura_header import IgnoreRect, SuraHeaderLocator

#: ``on_progress(phase, current_page, pages_saved)`` — ``phase`` is one of
#: ``rendering`` / ``detecting`` / ``saving``, ``current_page`` is a LOGICAL page
#: number, ``pages_saved`` counts pages already written to the DB by this run.
ProgressHook = Callable[[str, int | None, int], None]

logger = logging.getLogger(__name__)


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
    should_cancel: Callable[[], bool] | None = None,
    on_progress: ProgressHook | None = None,
    on_run_started: Callable[[uuid.UUID, str], None] | None = None,
) -> dict:
    """Render + detect a logical page range, persist rows, and log a run."""
    sura_template, aya_template = preflight(mushaf, page_range_start, page_range_end)

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
    filenames = [f"{n}.png" for n in page_numbers]
    overrides = dict(
        Page.objects.filter(mushaf=mushaf, page_number__in=page_numbers).values_list("page_number", "source_pdf_page")
    )

    token = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    log_rel = f"runs/{token}.log"
    log_path = settings.LOG_DIR / log_rel
    log_path.parent.mkdir(parents=True, exist_ok=True)
    prune_run_logs(log_path.parent)
    # Line-detection debug PNGs live under MEDIA_ROOT so they can be served and
    # shown in the abort diagnostics (see ``_media_url``).
    results_dir = Path(settings.MEDIA_ROOT) / "run_debug" / token
    results_dir.mkdir(parents=True, exist_ok=True)
    prune_run_debug(results_dir.parent)

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

    _settle_stale_runs(mushaf)
    run = ProcessingRun.objects.create(
        mushaf=mushaf,
        settings=settings_used,
        page_range_start=page_range_start,
        page_range_end=page_range_end,
        status=RunStatusChoices.RUNNING,
        log_path=log_rel,
    )
    log_url = f"/api/mushafs/{mushaf.id}/runs/{run.id}/log"
    if on_run_started is not None:
        on_run_started(run.id, log_url)

    pipeline = build_pipeline(
        crop_cfg=crop_cfg,
        det_cfg=det_cfg,
        proc_cfg=proc_cfg,
        export_cfg=export_cfg,
        aya_processor=aya_processor,
        results_dir=results_dir,
        sura_header_locator=sura_header_locator,
    )

    saved = 0

    def report(phase: str, current_page: int | None) -> None:
        if on_progress is not None:
            on_progress(phase, current_page, saved)

    def persist(outcome: PageOutcome) -> None:
        """Write one finished page immediately, so progress survives a stop."""
        nonlocal saved
        if outcome.coordinates is None:
            return
        page_number = page_range_start + outcome.page_index - 1
        with transaction.atomic():
            coordinates.write_coords_to_page(
                mushaf=mushaf, page_number=page_number, run=run, coord_page=outcome.coordinates
            )
        saved += 1
        report("saving", page_number)

    handler = setup_file_logging(str(log_path))
    try:
        with pdf.open_document(mushaf.pdf_file.path) as doc:
            images = _render_pages(doc, mushaf.first_quran_pdf_page, page_numbers, overrides, report)
            output = pipeline.run(
                images,
                filenames=filenames,
                should_cancel=should_cancel,
                on_page_start=lambda index, _name: report("detecting", page_range_start + index - 1),
                on_page_done=persist,
            )
    except Exception:
        ProcessingRun.objects.filter(id=run.id).update(status=RunStatusChoices.ERROR)
        raise
    finally:
        teardown_file_logging(handler)

    abort_at = output.get("abort_at")
    if isinstance(abort_at, dict):
        debug_paths = abort_at.pop("line_debug_outputs", None) or []
        abort_at["debug_images"] = [_media_url(p) for p in debug_paths]
    cancel_at = output.get("cancel_at")

    #: The logical page the run came to rest on — the one that failed detection,
    #: or the first one a cancel prevented. Both are 1-based within the batch.
    stopped_on: int | None = None
    for detail in (abort_at, cancel_at):
        if isinstance(detail, dict) and detail.get("page_index") is not None:
            stopped_on = page_range_start + detail["page_index"] - 1

    with transaction.atomic():
        ProcessingRun.objects.filter(id=run.id).update(
            status=output["status"],
            abort_info=json.dumps(abort_at) if abort_at else "",
        )
        event = {
            "run_id": str(run.id),
            "run_number": ProcessingRun.objects.filter(mushaf=mushaf).count(),
            "status": output["status"],
            "pages_saved": saved,
            "page_range_start": page_range_start,
            "page_range_end": page_range_end,
        }
        if stopped_on is not None:
            event["abort_page"] = stopped_on
        activity.emit(mushaf, ActivityTypeChoices.RUN_FINISHED, event)

    return {
        "run_id": run.id,
        "status": output["status"],
        "pages_processed": output["pages_processed"],
        "pages_saved": saved,
        "stopped_on_page": stopped_on,
        "start_sura": output["start_sura"],
        "start_aya": output["start_aya"],
        "end_sura": output["end_sura"],
        "end_aya": output["end_aya"],
        "results": output["results"],
        "abort_info": abort_at,
        "cancel_info": cancel_at,
        "log_url": log_url,
    }


def preflight(mushaf: Mushaf, page_range_start: int, page_range_end: int) -> tuple[Template, Template]:
    """Everything that must be checked while the caller can still be told.

    Once processing moves to a background job the HTTP response is already sent,
    so a bad range or a missing template would surface as a *failed run* instead
    of a rejected request. Callers therefore run these cheap DB-only checks
    up front (see views/processing.process); ``process`` repeats them so a direct
    call is never left unguarded.
    """
    validators.validate_page_range(mushaf, page_range_start, page_range_end)
    return _required_templates(mushaf)


def _render_pages(
    doc: fitz.Document,
    first_quran_pdf_page: int,
    page_numbers: list[int],
    overrides: dict[int, int | None],
    report: Callable[[str, int | None], None],
) -> Iterator[tuple[bytes, str]]:
    """Yield ``(png_bytes, filename)`` one page at a time, rendering on demand.

    Laziness is what makes a cancel cheap: the pipeline pulls the next page only
    after deciding to process it, so a stop never pays for a render (~0.3 s and
    several MB at 300 dpi) it would discard.
    """
    for n in page_numbers:
        report("rendering", n)
        pdf_index = pdf.logical_to_pdf_index(first_quran_pdf_page, n, overrides.get(n))
        yield pdf.render_page_from(doc, pdf_index), f"{n}.png"


def _retention(keep: int | None) -> int:
    if keep is None:
        keep = int(getattr(settings, "RUN_LOG_RETENTION", 30))
    return keep


def _stale_entries(listing: Callable[[], Iterable[Path]], keep: int) -> list[Path]:
    """Everything past the newest ``keep`` entries, by modification time.

    ``listing`` is deferred so the directory read happens inside the guard:
    filesystem errors leave the directory alone rather than failing the run that
    triggered the sweep. (``Path.iterdir`` scans eagerly, so passing an iterator
    would raise before ever getting here.)
    """
    try:
        ordered = sorted(listing(), key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        return []
    return ordered[keep:]


def prune_run_debug(debug_root: Path, keep: int | None = None) -> int:
    """Keep the newest ``keep`` run-debug directories; delete the rest.

    These hold the per-line PNGs written when a page fails line detection —
    far heavier than the logs, and only ever of interest for a recent run.
    """
    keep = _retention(keep)
    if keep < 0:
        return 0

    def directories() -> list[Path]:
        return [path for path in debug_root.iterdir() if path.is_dir()]

    removed = 0
    for stale in _stale_entries(directories, keep):
        shutil.rmtree(stale, ignore_errors=True)
        if not stale.exists():
            removed += 1
    if removed:
        logger.info("Pruned %d old run-debug directory(ies) from %s", removed, debug_root)
    return removed


def prune_run_logs(runs_dir: Path, keep: int | None = None) -> int:
    """Keep the newest ``keep`` run logs under *runs_dir*; delete the rest.

    Called when a run starts, so the directory stays bounded without a separate
    cleanup job. A whole-mushaf run logs several MB, which is the storage this
    reclaims — the ``ProcessingRun`` rows themselves are a few hundred bytes and
    are kept, so pruned runs still appear in the history.

    Rows that pointed at a deleted file have ``log_path`` cleared, which is what
    makes the UI honest: ``list_runs`` then reports ``log_url: null`` and the
    "view the log" affordances disappear instead of offering a dead link.

    Best-effort on the filesystem side: failing to delete an old log is never a
    reason to fail the run that triggered the sweep.
    """
    keep = _retention(keep)
    if keep < 0:
        return 0

    pruned: list[str] = []
    for stale in _stale_entries(lambda: runs_dir.glob("*.log"), keep):
        try:
            stale.unlink()
        except OSError:
            continue
        # Stored form is the POSIX-style path relative to LOG_DIR (see ``process``).
        pruned.append(f"{runs_dir.name}/{stale.name}")

    if pruned:
        ProcessingRun.objects.filter(log_path__in=pruned).update(log_path="")
        logger.info("Pruned %d old run log(s) from %s", len(pruned), runs_dir)
    return len(pruned)


def _settle_stale_runs(mushaf: Mushaf) -> int:
    """Close out ``running`` rows left behind by a crash or a server restart.

    Nothing can finish them — the in-memory job that owned them is gone — so the
    next run on the same mushaf marks them ``interrupted``. Safe to call before
    starting: services/jobs.py refuses to start a second run for a mushaf that
    already has a live one, so this never touches a run still in flight.
    """
    return ProcessingRun.objects.filter(mushaf=mushaf, status=RunStatusChoices.RUNNING).update(
        status=RunStatusChoices.INTERRUPTED
    )


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
            "log_path",
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
            "log_url": f"/api/mushafs/{mushaf.id}/runs/{row['id']}/log" if row["log_path"] else None,
        }
        for number, row in enumerate(rows, start=1)
    ]
    return serialized[::-1]


def _required_templates(mushaf: Mushaf) -> tuple[Template, Template]:
    by_type = {t.type: t for t in mushaf.templates.all()}
    try:
        return by_type["sura_header"], by_type["aya_separator"]
    except KeyError:
        raise HttpError(400, i18n.t("templates_required")) from None


def _load_image(template: Template) -> Image.Image:
    image = Image.open(template.image.path)
    image.load()
    return image


def _ignore_rect(data: dict) -> IgnoreRect | None:
    if not data:
        return None
    return IgnoreRect(x=data["x"], y=data["y"], w=data["w"], h=data["h"])


def _media_url(path: str) -> str:
    """Absolute path under MEDIA_ROOT → a leading-slash ``/media/...`` URL."""
    rel = Path(path).resolve().relative_to(Path(settings.MEDIA_ROOT).resolve())
    media_url = settings.MEDIA_URL.lstrip("/")
    return "/" + media_url + str(rel).replace("\\", "/")


#: Bytes served per tail request. A poll never returns an unbounded blob; a
#: viewer opened on a long finished run simply catches up over a few polls.
RUN_LOG_CHUNK_BYTES = 256 * 1024


def read_run_log_tail(
    mushaf: Mushaf,
    run_id: uuid.UUID,
    offset: int = 0,
    limit: int = RUN_LOG_CHUNK_BYTES,
) -> dict:
    """Read a run log forward from ``offset``, for a client that polls as it grows.

    Returns the text read plus the offset to resume from. Only whole lines are
    emitted: a chunk boundary must not split a UTF-8 sequence, and a reader
    tailing a file being written to must not be handed half a line it would
    then see repeated. Any remainder is picked up by the next call.

    ``reset`` says the file is shorter than the offset asked for — it was
    replaced or truncated — so the caller should clear what it has and start over.
    """
    path = run_log_file(mushaf, run_id)
    size = path.stat().st_size

    start = max(0, int(offset))
    reset = start > size
    if reset:
        start = 0

    limit = max(0, int(limit))
    with path.open("rb") as handle:
        handle.seek(start)
        chunk = handle.read(limit)

    if chunk and not chunk.endswith(b"\n"):
        cut = chunk.rfind(b"\n")
        if cut != -1:
            chunk = chunk[: cut + 1]
        elif len(chunk) < limit:
            # A partial line still being written, and no newline to fall back
            # on. Leave it for the next poll rather than emitting a fragment.
            chunk = b""
        # else: one line longer than the whole chunk — send it as-is, otherwise
        # the reader would never advance past it.

    return {
        "offset": start + len(chunk),
        "size": size,
        "text": chunk.decode("utf-8", errors="replace"),
        "reset": reset,
    }


def run_log_file(mushaf: Mushaf, run_id: uuid.UUID) -> Path:
    """Validated filesystem path to a run's detailed log (404 if missing/foreign)."""
    log_rel = mushaf.processing_runs.filter(id=run_id).values_list("log_path", flat=True).first()
    if not log_rel:
        raise HttpError(404, i18n.t("run_no_log"))
    log_dir = Path(settings.LOG_DIR).resolve()
    path = (log_dir / log_rel).resolve()
    if log_dir not in path.parents or not path.is_file():
        raise HttpError(404, i18n.t("log_not_found"))
    return path

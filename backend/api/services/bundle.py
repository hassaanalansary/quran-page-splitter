"""The portable work bundle — ``mushaf-work/v1``.

A mushaf's *work* (page bounds, line and segment geometry, sura assignments,
erase strokes, template crops) packaged as a zip you can archive, email, or
re-import after moving databases. What it deliberately does **not** carry is the
PDF itself: the bundle names the PDF by ``pdf_sha256`` and import refuses unless
the target mushaf was built from that exact file. A 143 MB PDF in every bundle
would make the format useless for sharing, and the hash gives a stronger
guarantee than shipping the bytes would.

A zip rather than one JSON file because template crops are binary; base64 inside
JSON would inflate them for nothing.

This module also owns the canonical tree (de)serialization, which
``services.cloning`` reuses — duplicating a mushaf and importing a bundle write
rows through the very same function, so the two cannot drift apart.
"""

import json
import logging
import shutil
import uuid
import zipfile
from datetime import UTC, datetime
from tempfile import SpooledTemporaryFile
from typing import Any

from django.core.files.base import ContentFile
from django.db import transaction
from ninja.errors import HttpError
from ninja.files import UploadedFile

from accounts.models import User
from api import i18n
from api.models import (
    ActivityTypeChoices,
    EraseStroke,
    Line,
    Mushaf,
    Page,
    Segment,
    Template,
    TemplateTypeChoices,
)
from api.services import activity

logger = logging.getLogger(__name__)

SCHEMA = "mushaf-work/v1"

MANIFEST_NAME = "manifest.json"
PAGES_NAME = "pages.json"
TEMPLATE_DIR = "templates"

#: Same threshold as the line-image zip: buffer in RAM, spill to disk beyond it.
SPOOL_MAX_BYTES = 16 * 1024 * 1024

#: Refuse absurd members before decompressing them. A fully-worked 604-page
#: mushaf serializes to roughly 6 MB of JSON, so this is ~30x headroom while
#: still stopping a decompression bomb.
MAX_JSON_BYTES = 200 * 1024 * 1024
MAX_TEMPLATE_BYTES = 20 * 1024 * 1024

BATCH_SIZE = 2000


# --------------------------------------------------------------------------
# Tree serialization — shared with services.cloning
# --------------------------------------------------------------------------


def serialize_tree(mushaf: Mushaf) -> list[dict]:
    """The mushaf's page tree as plain JSON-ready dicts, in page order."""
    lines_by_page: dict[int, list[dict]] = {}
    segments_by_line: dict[uuid.UUID, list[dict]] = {}
    strokes_by_line: dict[uuid.UUID, list[dict]] = {}

    for segment in Segment.objects.filter(line__page__mushaf=mushaf).order_by("segment_order"):
        segments_by_line.setdefault(segment.line_id, []).append(
            {
                "segment_order": segment.segment_order,
                "bbox_x": segment.bbox_x,
                "bbox_w": segment.bbox_w,
                "has_separator": segment.has_separator,
                "aya_number": segment.aya_number,
            }
        )
    for stroke in EraseStroke.objects.filter(line__page__mushaf=mushaf):
        strokes_by_line.setdefault(stroke.line_id, []).append(
            {"brush_size": stroke.brush_size, "points": stroke.points}
        )

    for line in Line.objects.filter(page__mushaf=mushaf).select_related("page").order_by("line_number"):
        lines_by_page.setdefault(line.page.page_number, []).append(
            {
                "line_number": line.line_number,
                "type": line.type,
                "sura_number": line.sura_id,
                "bbox_x": line.bbox_x,
                "bbox_y": line.bbox_y,
                "bbox_w": line.bbox_w,
                "bbox_h": line.bbox_h,
                "segments": segments_by_line.get(line.id, []),
                "erase_strokes": strokes_by_line.get(line.id, []),
            }
        )

    return [
        {
            "page_number": page.page_number,
            "source_pdf_page": page.source_pdf_page,
            "bbox_x": page.bbox_x,
            "bbox_y": page.bbox_y,
            "bbox_w": page.bbox_w,
            "bbox_h": page.bbox_h,
            "reviewed": page.reviewed,
            "lines": lines_by_page.get(page.page_number, []),
        }
        for page in mushaf.pages.all().order_by("page_number")
    ]


def write_tree(target: Mushaf, pages: list[dict]) -> None:
    """Write a serialized tree onto ``target``, parent-first via bulk_create.

    Assumes the caller has already cleared any existing pages and is inside a
    transaction. ``line_png`` is deliberately never set: exported images are
    derived output and belong to whoever exports them.
    """
    if not pages:
        return

    Page.objects.bulk_create(
        [
            Page(
                mushaf=target,
                page_number=page["page_number"],
                source_pdf_page=page.get("source_pdf_page"),
                last_run=None,
                bbox_x=page.get("bbox_x"),
                bbox_y=page.get("bbox_y"),
                bbox_w=page.get("bbox_w"),
                bbox_h=page.get("bbox_h"),
                reviewed=bool(page.get("reviewed")),
            )
            for page in pages
        ],
        batch_size=BATCH_SIZE,
    )
    new_page_by_number = {p.page_number: p for p in target.pages.all()}

    line_rows = [(page["page_number"], line) for page in pages for line in page.get("lines", [])]
    if not line_rows:
        return

    Line.objects.bulk_create(
        [
            Line(
                page=new_page_by_number[page_number],
                line_number=line["line_number"],
                type=line["type"],
                sura_id=line.get("sura_number"),
                bbox_x=line["bbox_x"],
                bbox_y=line["bbox_y"],
                bbox_w=line["bbox_w"],
                bbox_h=line["bbox_h"],
            )
            for page_number, line in line_rows
        ],
        batch_size=BATCH_SIZE,
    )

    # (page_number, line_number) is unique within a mushaf, so it keys the
    # freshly written rows back to their source dicts.
    new_line_by_key = {
        (line.page.page_number, line.line_number): line
        for line in Line.objects.filter(page__mushaf=target).select_related("page")
    }

    Segment.objects.bulk_create(
        [
            Segment(
                line=new_line_by_key[(page_number, line["line_number"])],
                segment_order=segment.get("segment_order", index),
                bbox_x=segment["bbox_x"],
                bbox_w=segment["bbox_w"],
                has_separator=segment.get("has_separator", False),
                aya_number=segment.get("aya_number"),
            )
            for page_number, line in line_rows
            for index, segment in enumerate(line.get("segments", []), start=1)
        ],
        batch_size=BATCH_SIZE,
    )

    EraseStroke.objects.bulk_create(
        [
            EraseStroke(
                line=new_line_by_key[(page_number, line["line_number"])],
                brush_size=stroke.get("brush_size", 12),
                points=stroke.get("points", []),
            )
            for page_number, line in line_rows
            for stroke in line.get("erase_strokes", [])
        ],
        batch_size=BATCH_SIZE,
    )


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------


def _safe_filename(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_ " else "-" for ch in name).strip()
    return (cleaned or "mushaf").replace(" ", "-")


def _last_run_settings(mushaf: Mushaf) -> dict | None:
    """The most recent run's settings, so the recipe travels with the work."""
    run = mushaf.processing_runs.order_by("-created_at").first()
    return run.settings if run else None


def build(mushaf_id: uuid.UUID, *, user: User | None) -> tuple[str, SpooledTemporaryFile]:
    """Package a mushaf's work as a zip, ready to stream as a download."""
    from api.services import mushaf as mushaf_service

    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user, write=False)
    pages = serialize_tree(mushaf)

    templates = []
    for template in mushaf.templates.order_by("type"):
        templates.append(
            {
                "type": template.type,
                "file": f"{TEMPLATE_DIR}/{template.type}.png",
                "ignore_rects": template.ignore_rects,
            }
        )

    manifest: dict[str, Any] = {
        "schema": SCHEMA,
        "exported_at": datetime.now(UTC).isoformat(),
        "mushaf": {
            "name": mushaf.name,
            "description": mushaf.description,
            "qiraa": mushaf.qiraa.name if mushaf.qiraa else None,
            # The contract: this bundle describes work over one specific PDF.
            "pdf_sha256": mushaf.pdf_sha256,
            "pdf_page_count": mushaf.pdf_page_count,
            "pdf_original_name": mushaf.pdf_original_name,
            "first_quran_pdf_page": mushaf.first_quran_pdf_page,
            "last_quran_pdf_page": mushaf.last_quran_pdf_page,
        },
        "counts": {
            "pages": len(pages),
            "lines": sum(len(p["lines"]) for p in pages),
            "segments": sum(len(line["segments"]) for p in pages for line in p["lines"]),
            "erase_strokes": sum(len(line["erase_strokes"]) for p in pages for line in p["lines"]),
        },
        "templates": templates,
        "last_run_settings": _last_run_settings(mushaf),
    }

    # Not a context manager: the caller streams from it and closes it.
    buffer: SpooledTemporaryFile = SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES)  # noqa: SIM115
    # JSON compresses very well (it is mostly repeated keys and integers), unlike
    # the already-compressed PNGs in the line-image zip.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr(PAGES_NAME, json.dumps({"pages": pages}, ensure_ascii=False))
        for template in mushaf.templates.order_by("type"):
            if not template.image:
                continue
            try:
                template.image.open("rb")
                archive.writestr(f"{TEMPLATE_DIR}/{template.type}.png", template.image.read())
            except (OSError, ValueError):
                logger.warning("Template image %s missing; omitted from bundle", template.image.name)
            finally:
                template.image.close()

    buffer.seek(0)
    return f"{_safe_filename(mushaf.name)}-work.zip", buffer


# --------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------


def _read_member(archive: zipfile.ZipFile, name: str, *, max_bytes: int) -> bytes | None:
    """Read one member **by exact name**, refusing oversized entries.

    Members are never extracted to disk and never addressed by a name taken from
    the archive itself, so a crafted path like ``../../etc/passwd`` simply does
    not match anything we ask for. The size check reads the declared size from
    the header before decompressing, which stops a zip bomb.
    """
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > max_bytes:
        raise HttpError(400, i18n.t("bundle_invalid"))
    return archive.read(info)


def _restore_templates(target: Mushaf, archive: zipfile.ZipFile, manifest: dict) -> None:
    """Recreate template crops from the bundle, replacing any already there."""
    entries = manifest.get("templates") or []
    for entry in entries:
        template_type = entry.get("type")
        if template_type not in TemplateTypeChoices.values:
            continue  # unknown type from a future version — skip rather than fail
        data = _read_member(archive, f"{TEMPLATE_DIR}/{template_type}.png", max_bytes=MAX_TEMPLATE_BYTES)
        template, _ = Template.objects.update_or_create(
            mushaf=target,
            type=template_type,
            defaults={"ignore_rects": entry.get("ignore_rects") or {}},
        )
        if data:
            superseded = template.image.name
            template.image.save(f"{template_type}.png", ContentFile(data), save=True)
            if superseded and superseded != template.image.name:
                try:
                    template.image.storage.delete(superseded)
                except OSError:
                    logger.warning("Could not delete superseded template image %s", superseded)


def apply_bundle(
    mushaf_id: uuid.UUID,
    upload: UploadedFile,
    *,
    user: User,
    replace: bool = False,
) -> dict:
    """Apply a work bundle to one of the caller's mushafs.

    The sha256 check is the point of the format: the geometry in a bundle is
    only meaningful over the PDF it was derived from, so applying it to a
    different edition would silently produce nonsense coordinates.
    """
    from api.services import mushaf as mushaf_service

    target = mushaf_service.get_mushaf(mushaf_id, user=user)

    # Copy the upload into a seekable buffer — ZipFile needs to seek, and a
    # streamed multipart upload may not be.
    source_file = getattr(upload, "file", None)
    if source_file is None:
        raise HttpError(400, i18n.t("bundle_invalid"))

    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as buffer:
        shutil.copyfileobj(source_file, buffer)
        buffer.seek(0)

        try:
            archive = zipfile.ZipFile(buffer)
        except zipfile.BadZipFile as exc:
            raise HttpError(400, i18n.t("bundle_invalid")) from exc

        with archive:
            raw_manifest = _read_member(archive, MANIFEST_NAME, max_bytes=MAX_JSON_BYTES)
            raw_pages = _read_member(archive, PAGES_NAME, max_bytes=MAX_JSON_BYTES)
            if raw_manifest is None or raw_pages is None:
                raise HttpError(400, i18n.t("bundle_invalid"))

            try:
                manifest = json.loads(raw_manifest)
                pages = json.loads(raw_pages).get("pages", [])
            except (json.JSONDecodeError, AttributeError) as exc:
                raise HttpError(400, i18n.t("bundle_invalid")) from exc

            if manifest.get("schema") != SCHEMA:
                raise HttpError(
                    400,
                    i18n.t("bundle_schema_unknown", schema=manifest.get("schema"), expected=SCHEMA),
                )

            source = manifest.get("mushaf") or {}
            bundle_sha = source.get("pdf_sha256") or ""
            if bundle_sha != target.pdf_sha256:
                raise HttpError(
                    409,
                    i18n.t(
                        "bundle_pdf_mismatch",
                        bundle=bundle_sha[:12],
                        target=target.pdf_sha256[:12],
                    ),
                )

            if target.pages.exists() and not replace:
                raise HttpError(409, i18n.t("bundle_has_pages", count=target.pages.count()))

            with transaction.atomic():
                # Cascade clears lines, segments and strokes with the pages.
                target.pages.all().delete()
                write_tree(target, pages)
                _restore_templates(target, archive, manifest)

                activity.emit(
                    target,
                    ActivityTypeChoices.MUSHAF_CREATED,
                    {
                        "imported_from": source.get("name", ""),
                        "pages": len(pages),
                        "exported_at": manifest.get("exported_at", ""),
                    },
                    actor=user,
                )

    # Bounds and page-count differences are reported, not enforced: the same PDF
    # can legitimately be set up with a different first/last Quran page.
    warnings = {
        "bounds_differ": (
            source.get("first_quran_pdf_page") != target.first_quran_pdf_page
            or source.get("last_quran_pdf_page") != target.last_quran_pdf_page
        ),
        "page_count_differs": source.get("pdf_page_count") != target.pdf_page_count,
    }
    logger.info("Imported %d pages into mushaf %s", len(pages), target.id)
    return {
        "pages_imported": len(pages),
        "lines_imported": sum(len(p.get("lines", [])) for p in pages),
        "source_name": source.get("name", ""),
        "warnings": warnings,
    }

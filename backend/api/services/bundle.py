"""The portable work bundle — ``mushaf-work/v2`` (also reads v1).

A mushaf's *work* (page bounds, line and segment geometry, sura assignments,
erase strokes, template crops) packaged as a zip you can archive, email, or
re-import after moving databases. What it deliberately does **not** carry is the
PDF itself: the bundle names the PDF by ``pdf_sha256`` and import refuses unless
the target mushaf was built from that exact file. A 143 MB PDF in every bundle
would make the format useless for sharing, and the hash gives a stronger
guarantee than shipping the bytes would.

A zip rather than one JSON file because template crops are binary; base64 inside
JSON would inflate them for nothing.

Because the hash *identifies* the work, it can also find its home:
``inspect_bundle`` reads a manifest and reports which of the caller's mushafs
the zip belongs to, so nobody has to match a checksum by eye. That answer is a
shortlist only — ``apply_bundle`` still re-checks the hash against whichever
mushaf the user approves.

This module also owns the canonical tree (de)serialization, which
``services.cloning`` reuses — duplicating a mushaf and importing a bundle write
rows through the very same function, so the two cannot drift apart.
"""

import json
import logging
import shutil
import uuid
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime
from tempfile import SpooledTemporaryFile
from typing import Any

from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import F
from ninja.errors import HttpError
from ninja.files import UploadedFile

from accounts.models import User
from api import i18n
from api.models import (
    ActivityTypeChoices,
    CalibrationProfile,
    CalibrationReview,
    CalibrationRevision,
    CalibrationRevisionKind,
    CalibrationSnapshot,
    EraseStroke,
    Line,
    LineWord,
    LineWordStatus,
    Mushaf,
    Page,
    Segment,
    Template,
    TemplateTypeChoices,
)
from api.services import activity

logger = logging.getLogger(__name__)

SCHEMA = "mushaf-work/v2"
SUPPORTED_SCHEMAS = ("mushaf-work/v1", SCHEMA)

MANIFEST_NAME = "manifest.json"
PAGES_NAME = "pages.json"
CALIBRATION_NAME = "calibration.json"
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

    for line in (
        Line.objects.filter(page__mushaf=mushaf)
        .select_related("page", "word_status")
        .prefetch_related("words")
        .order_by("line_number")
    ):
        status = getattr(line, "word_status", None)
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
                "words": [
                    {"word_id": word.word_id, "position": word.position, "start_x": word.start_x, "end_x": word.end_x}
                    for word in line.words.all()
                ],
                "word_status": {
                    "status": status.status,
                    "reason": status.reason,
                    "deviations": status.deviations,
                    "ties": status.ties,
                    "edited": status.edited,
                }
                if status
                else None,
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

    LineWord.objects.bulk_create(
        [
            LineWord(
                line=new_line_by_key[(page_number, line["line_number"])],
                word_id=word.get("word_id"),
                position=word.get("position", index),
                start_x=word["start_x"],
                end_x=word["end_x"],
            )
            for page_number, line in line_rows
            for index, word in enumerate(line.get("words", []))
        ],
        batch_size=BATCH_SIZE,
    )
    LineWordStatus.objects.bulk_create(
        [
            LineWordStatus(
                line=new_line_by_key[(page_number, line["line_number"])],
                **{
                    key: value
                    for key, value in line["word_status"].items()
                    if key in ("status", "reason", "deviations", "ties", "edited")
                },
            )
            for page_number, line in line_rows
            if line.get("word_status")
        ],
        batch_size=BATCH_SIZE,
    )


def serialize_calibration(mushaf: Mushaf) -> dict:
    """Portable history and index inputs; runtime indexes and approval do not travel."""
    return {
        "source_mushaf_id": str(mushaf.pk),
        "snapshots": [
            {
                "id": str(snapshot.pk),
                "page_number": snapshot.page_number,
                "line_number": snapshot.line_number,
                "source_line_id": str(snapshot.source_line_id) if snapshot.source_line_id else None,
                "fingerprint": snapshot.fingerprint,
                "metadata": deepcopy(snapshot.metadata),
            }
            for snapshot in mushaf.calibration_snapshots.order_by("page_number", "line_number", "pk")
        ],
        "reviews": [
            {
                "page_number": review.page_number,
                "revision": review.revision,
                "confirmed_revision": review.confirmed_revision,
                "payload": deepcopy(review.payload),
                "revisions": [
                    {
                        # Profiles name the approvals they were built from by id.
                        "id": str(revision.pk),
                        "number": revision.number,
                        "kind": revision.kind,
                        "payload": deepcopy(revision.payload),
                        "request_id": str(revision.request_id) if revision.request_id else None,
                    }
                    for revision in review.revisions.all()
                ],
            }
            for review in mushaf.calibration_reviews.order_by("page_number").prefetch_related("revisions")
        ],
        "profiles": [
            {"signature": profile.signature, "payload": _portable_profile(profile.payload), "mode": "shadow"}
            for profile in mushaf.calibration_profiles.order_by("signature")
        ],
    }


def _revision_kind(revision: dict) -> str:
    """A revision's kind, validated — a bundle is untrusted input."""
    kind = revision.get("kind")
    if kind not in CalibrationRevisionKind.values:
        raise ValueError(f"Unknown calibration revision kind {kind!r}")
    return str(kind)


def _portable_profile(payload: dict) -> dict:
    return {
        key: deepcopy(value)
        for key, value in payload.items()
        if key not in ("index", "cached_index", "index_path", "active_approval", "approved", "approved_at", "mode")
    }


def _remap_snapshot_refs(value: Any, ids: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {ids.get(key, key): _remap_snapshot_refs(item, ids) for key, item in value.items()}
    if isinstance(value, list):
        return [_remap_snapshot_refs(item, ids) for item in value]
    return ids.get(value, value) if isinstance(value, str) else value


def _rebind_lines(value: Any, lines: dict[tuple[int, int], str], page: int) -> Any:
    """Point every row at the target's own line with the same page and line number.

    Rows name their ``Line`` by id, and a copy's lines are new rows: left pointing at
    the original's, every review would arrive stale. The original id is kept beside
    the new one as provenance. A row whose line the target does not have keeps its
    old id, and reads as stale — which is then the truth.
    """
    if isinstance(value, list):
        return [_rebind_lines(item, lines, page) for item in value]
    if not isinstance(value, dict):
        return value
    out = {key: _rebind_lines(item, lines, page) for key, item in value.items()}
    if "line_id" in out and "line_number" in out:
        own = lines.get((int(out.get("page_number", page)), int(out["line_number"])))
        if own is not None and own != out["line_id"]:
            out.setdefault("source_line_id", out["line_id"])
            out["line_id"] = own
    return out


def _offset_revisions(payload: dict, offset: int) -> dict:
    """Shift a payload's references to revision numbers by the history it joins."""
    if offset and isinstance(payload.get("processed_revision"), int):
        payload = {**payload, "processed_revision": payload["processed_revision"] + offset}
    return payload


def restore_calibration(target: Mushaf, data: dict, read_file: Callable[[str, str], bytes | None]) -> None:
    """Restore files into target-owned paths and rebind every reference to the target.

    Snapshot ids, revision ids and line ids are all the target's own afterwards, so
    a copy's unchanged pages read as current, not stale; each original id is kept
    beside its replacement as provenance. Existing history stays immutable when
    importing over a worked target: imported revisions are appended after it, and
    every reference to a revision number is shifted to match.
    """
    from api.models import CalibrationSettings

    # Activation is local consent, never portable data, even on an existing target.
    CalibrationSettings.objects.filter(mushaf=target).update(experimental=False, revision=F("revision") + 1)
    lines = {
        (page_number, line_number): str(pk)
        for page_number, line_number, pk in Line.objects.filter(page__mushaf=target).values_list(
            "page__page_number", "line_number", "pk"
        )
    }
    ids: dict[str, str] = {}
    for entry in data.get("snapshots", []):
        source_id = str(uuid.UUID(entry["id"]))
        own_line = lines.get((entry.get("page_number"), entry.get("line_number")))
        snapshot, created = CalibrationSnapshot.objects.get_or_create(
            mushaf=target,
            fingerprint=entry["fingerprint"],
            defaults={
                "page_number": entry.get("page_number"),
                "line_number": entry.get("line_number"),
                "source_line_id": own_line or entry.get("source_line_id"),
            },
        )
        ids[source_id] = str(snapshot.pk)
        if created:
            snapshot.metadata = deepcopy(entry.get("metadata", {}))
            snapshot.metadata.setdefault("source_mushaf_id", data.get("source_mushaf_id"))
            snapshot.metadata.setdefault("source_snapshot_id", source_id)
            snapshot.metadata.setdefault("source_line_id", entry.get("source_line_id"))
            for field in ("image", "labels"):
                content = read_file(source_id, field)
                if content is None:
                    raise ValueError(f"Missing calibration snapshot {source_id}/{field}.png")
                getattr(snapshot, field).save(f"{field}.png", ContentFile(content), save=False)
            snapshot.save()

    for entry in data.get("reviews", []):
        review, _ = CalibrationReview.objects.select_for_update().get_or_create(
            mushaf=target, page_number=entry["page_number"]
        )
        offset = review.revision
        page = int(entry["page_number"])
        used_requests = set(review.revisions.values_list("request_id", flat=True))
        for revision in entry.get("revisions", []):
            request_id = uuid.UUID(revision["request_id"]) if revision.get("request_id") else None
            payload = _remap_snapshot_refs(revision.get("payload", {}), ids)
            created_revision = CalibrationRevision.objects.create(
                review=review,
                number=offset + revision["number"],
                kind=_revision_kind(revision),
                payload=_offset_revisions(_rebind_lines(payload, lines, page), offset),
                request_id=request_id if request_id not in used_requests else None,
            )
            if revision.get("id"):
                ids[str(uuid.UUID(revision["id"]))] = str(created_revision.pk)
        review.revision = offset + entry["revision"]
        confirmed = entry.get("confirmed_revision")
        review.confirmed_revision = offset + confirmed if confirmed is not None else review.confirmed_revision
        payload = _remap_snapshot_refs(entry.get("payload", {}), ids)
        review.payload = _offset_revisions(_rebind_lines(payload, lines, page), offset)
        if "profile" in review.payload:
            review.payload["profile"] = {**review.payload["profile"], "mode": "shadow"}
        review.save()

    for entry in data.get("profiles", []):
        CalibrationProfile.objects.update_or_create(
            mushaf=target,
            signature=entry["signature"],
            defaults={"mode": "shadow", "payload": _remap_snapshot_refs(_portable_profile(entry["payload"]), ids)},
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
    calibration = serialize_calibration(mushaf)

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
            "qiraa": mushaf.rawi.name if mushaf.rawi else None,
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
        if any(calibration[key] for key in ("snapshots", "reviews", "profiles")):
            archive.writestr(CALIBRATION_NAME, json.dumps(calibration, ensure_ascii=False))
            for snapshot in mushaf.calibration_snapshots.all():
                for field in ("image", "labels"):
                    stored = getattr(snapshot, field)
                    with stored.open("rb") as source:
                        archive.writestr(f"calibration/{snapshot.pk}/{field}.png", source.read())
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


def _section(manifest: dict, key: str) -> dict:
    """One mapping out of a manifest, tolerating a hostile or truncated one.

    Everything in an uploaded manifest is attacker-controlled, so a value that
    should be an object may be a string — read that as an empty section rather
    than let an ``AttributeError`` surface as a 500.
    """
    value = manifest.get(key)
    return value if isinstance(value, dict) else {}


def read_manifest(archive: zipfile.ZipFile) -> dict:
    """The bundle's manifest, or an ``HttpError`` saying why this is not one.

    Both required members are checked here so "is this a work bundle?" has
    exactly one answer, whether the caller is about to apply it or only to look
    at it.
    """
    raw = _read_member(archive, MANIFEST_NAME, max_bytes=MAX_JSON_BYTES)
    if raw is None:
        raise HttpError(400, i18n.t("bundle_invalid"))

    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HttpError(400, i18n.t("bundle_invalid")) from exc
    if not isinstance(manifest, dict):
        raise HttpError(400, i18n.t("bundle_invalid"))

    if manifest.get("schema") not in SUPPORTED_SCHEMAS:
        raise HttpError(
            400,
            i18n.t("bundle_schema_unknown", schema=manifest.get("schema"), expected=SCHEMA),
        )
    if PAGES_NAME not in archive.namelist():
        raise HttpError(400, i18n.t("bundle_invalid"))
    return manifest


@contextmanager
def open_bundle(upload: UploadedFile) -> Iterator[tuple[zipfile.ZipFile, dict]]:
    """Open an uploaded bundle, yielding its archive and validated manifest.

    The upload is copied into a seekable buffer first — ``ZipFile`` seeks, and a
    streamed multipart upload may not.
    """
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
            yield archive, read_manifest(archive)


def _divergence(source: dict, *, first_page: int, last_page: int, page_count: int) -> dict:
    """How a bundle's setup differs from a candidate target's.

    Reported, never enforced: the same PDF can legitimately be set up with a
    different first/last Quran page, and only the user knows whether that
    matters. One definition, used both *before* an import (to warn on the
    approval dialog) and *after* one (to warn on the result).
    """
    return {
        "bounds_differ": (
            source.get("first_quran_pdf_page") != first_page or source.get("last_quran_pdf_page") != last_page
        ),
        "page_count_differs": source.get("pdf_page_count") != page_count,
    }


def _restore_templates(target: Mushaf, archive: zipfile.ZipFile, manifest: dict) -> None:
    """Recreate template crops from the bundle, replacing any already there."""
    entries = manifest.get("templates")
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
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


def inspect_bundle(upload: UploadedFile, *, user: User) -> dict:
    """Read a bundle's manifest and find which of the caller's mushafs it fits.

    The sha256 that import *enforces* is also what identifies a bundle's home,
    so the field that refuses a wrong target can just as well find the right
    one — nobody should have to recognise a checksum by eye to import their own
    work. Nothing is written here, and the answer is only a shortlist: the real
    import re-checks the hash against whichever mushaf the user approves.

    The lookup is scoped to the caller's own mushafs. Searching everyone's would
    turn this into an oracle for "who else here has this PDF?", and would print
    strangers' mushaf names into the dialog.
    """
    from api.services import mushaf as mushaf_service

    with open_bundle(upload) as (_, manifest):
        source = _section(manifest, "mushaf")
        counts = _section(manifest, "counts")
        exported_at = manifest.get("exported_at")

    sha = source.get("pdf_sha256") or ""
    candidates = mushaf_service.list_mushafs(user=user, pdf_sha256=sha) if sha else []

    return {
        "bundle": {
            "name": source.get("name") or "",
            "qiraa": source.get("qiraa"),
            "pdf_sha256": sha,
            "pdf_original_name": source.get("pdf_original_name") or "",
            "pdf_page_count": source.get("pdf_page_count") or 0,
            "first_quran_pdf_page": source.get("first_quran_pdf_page") or 1,
            "last_quran_pdf_page": source.get("last_quran_pdf_page"),
            "exported_at": exported_at if isinstance(exported_at, str) else "",
            "pages": counts.get("pages") or 0,
            "lines": counts.get("lines") or 0,
            "segments": counts.get("segments") or 0,
        },
        "matches": [
            candidate
            | _divergence(
                source,
                first_page=candidate["first_quran_pdf_page"],
                last_page=candidate["last_quran_pdf_page"],
                page_count=candidate["pdf_page_count"],
            )
            for candidate in candidates
        ],
    }


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

    with open_bundle(upload) as (archive, manifest):
        raw_pages = _read_member(archive, PAGES_NAME, max_bytes=MAX_JSON_BYTES)
        if raw_pages is None:
            raise HttpError(400, i18n.t("bundle_invalid"))

        try:
            pages = json.loads(raw_pages).get("pages", [])
        except (json.JSONDecodeError, AttributeError) as exc:
            raise HttpError(400, i18n.t("bundle_invalid")) from exc
        if not isinstance(pages, list):
            raise HttpError(400, i18n.t("bundle_invalid"))

        source = _section(manifest, "mushaf")
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
            if manifest["schema"] == SCHEMA:
                raw_calibration = _read_member(archive, CALIBRATION_NAME, max_bytes=MAX_JSON_BYTES)
                if raw_calibration is not None:
                    try:
                        calibration = json.loads(raw_calibration)
                        if not isinstance(calibration, dict):
                            raise ValueError("Calibration must be an object")
                        restore_calibration(
                            target,
                            calibration,
                            lambda snapshot_id, field: _read_member(
                                archive, f"calibration/{snapshot_id}/{field}.png", max_bytes=MAX_TEMPLATE_BYTES
                            ),
                        )
                    except (ValueError, KeyError, TypeError, AttributeError) as exc:
                        raise HttpError(400, i18n.t("bundle_invalid")) from exc

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

    logger.info("Imported %d pages into mushaf %s", len(pages), target.id)
    # Bounds and page-count differences are reported, not enforced.
    return {
        "pages_imported": len(pages),
        "lines_imported": sum(len(p.get("lines", [])) for p in pages),
        "source_name": source.get("name", ""),
        "warnings": _divergence(
            source,
            first_page=target.first_quran_pdf_page,
            last_page=target.last_quran_pdf_page,
            page_count=target.pdf_page_count,
        ),
    }

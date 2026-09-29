"""Measure each text line once, over its full box, and keep the result for good.

Calibration labels a *blob* — "component 23 of this line is a mark" — and that label
means something only against the exact pixels it was given on. Two things in the
word run's own path break that:

* **Cropping.** A run cuts the first and last line of its span at an aya boundary.
  A cut image gets new connected-component numbers *and* a re-measured writing band,
  so the same ink comes back under a different id with a different body score.
* **Lifetime.** Re-processing a page deletes its ``Line`` rows.

So a line is measured here once, uncut, and stored as a ``CalibrationSnapshot``:
the image, an RGB raster of blob ids the same size (the browser's hit-test map),
and every blob's geometry and evidence. A span then *selects* blobs from it
(:func:`select_span`) instead of cutting the picture.

``extract_line`` only measures and ``snapshot_line`` also stores, so a benchmark can
measure without writing anything.
"""

from __future__ import annotations

import hashlib
import io
import json
from collections import OrderedDict
from dataclasses import asdict, dataclass, fields
from typing import Any

import numpy as np
from django.core.files.base import ContentFile
from PIL import Image

from api.models import CalibrationSnapshot, Line, Mushaf, Template
from api.services import line_images
from core.word_boundary import LineImage
from core.word_boundary.examples import FEATURE_VERSION, feature_vector
from core.word_boundary.ink import Blob, LineInk, analyse_line
from core.word_boundary.separators import prepare_template, split_separators, split_symbols

#: Bump when measurement changes in a way that should make new snapshots.
EXTRACTION_VERSION = "full-line-v1"

#: Templates whose pictures change what a line measures as. The aya ornament sets
#: each supplied span's width; the symbols are matched and removed. A sura-header
#: template touches no text line, so re-capturing it must not stale every review.
_MEASURING_TEMPLATES = ("aya_separator", *line_images.SYMBOL_TEMPLATE_TYPES)


def digest(value: object) -> str:
    """A stable hash of JSON-able data — key order and spacing do not matter."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


#: Template digests by (row, save, file): any save of the row changes the key.
_TEMPLATE_DIGESTS: dict[tuple[str, str, str], str] = {}


def _template_digest(template: Template) -> str:
    """A template's pixels, by content.

    Never by path. The path names the mushaf, so a copy's templates would never
    match and every review it carried would arrive stale. And a redrawn crop is
    saved under a suffixed name while its predecessor is deleted, so a third
    capture can land back on the first one's name — a path would then call
    snapshots measured with other pixels current.
    """
    key = (str(template.pk), template.updated_at.isoformat(), template.image.name or "")
    found = _TEMPLATE_DIGESTS.get(key)
    if found is None:
        with template.image.open("rb") as stored:
            found = hashlib.sha256(stored.read()).hexdigest()
        _TEMPLATE_DIGESTS[key] = found
    return found


def source_signature(line: Line) -> dict:
    """Everything a line's measurement depends on, and nothing else.

    Nothing that names this mushaf rather than its content — no ids, no paths — so
    a duplicate's unchanged lines sign the same as the originals they were copied
    from, and the reviews that travelled with them stay current.
    """
    mushaf = line.page.mushaf
    return {
        "version": EXTRACTION_VERSION,
        "pdf": mushaf.pdf_sha256,
        "pdf_page": line.page.source_pdf_page,
        "first_pdf_page": mushaf.first_quran_pdf_page,
        "page": line.page.page_number,
        "line": line.line_number,
        "bbox": [line.bbox_x, line.bbox_y, line.bbox_w, line.bbox_h],
        "type": line.type,
        "sura": line.sura_id,
        "segments": list(
            line.segments.order_by("segment_order").values(
                "segment_order", "bbox_x", "bbox_w", "has_separator", "aya_number"
            )
        ),
        "erase": list(line.erase_strokes.order_by("id").values("brush_size", "points")),
        "templates": [
            {"type": template.type, "pixels": _template_digest(template)}
            for template in mushaf.templates.filter(type__in=_MEASURING_TEMPLATES).order_by("type")
            if template.image
        ],
    }


def source_fingerprint(line: Line) -> str:
    return digest(source_signature(line))


# ---------------------------------------------------------------------------
# The blob-id raster
# ---------------------------------------------------------------------------
def encode_labels(labels: np.ndarray) -> Image.Image:
    """Blob ids as an RGB image: id = R + 256·G + 65536·B, 0 for background.

    RGB rather than a 16-bit grey PNG because a browser canvas reads RGB back
    exactly, and that is where the hit-testing happens.
    """
    numbers = labels.astype(np.uint32)
    channels = np.stack((numbers & 255, (numbers >> 8) & 255, (numbers >> 16) & 255), axis=-1)
    return Image.fromarray(channels.astype("uint8"))


def decode_labels(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint32)
    return (rgb[:, :, 0] | (rgb[:, :, 1] << 8) | (rgb[:, :, 2] << 16)).astype(np.int32)


def png_bytes(image: Image.Image) -> bytes:
    data = io.BytesIO()
    image.save(data, format="PNG")
    return data.getvalue()


# ---------------------------------------------------------------------------
# Measuring
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Templates:
    """The mushaf's measuring templates, prepared once per run."""

    ornament: Image.Image | None
    ornament_array: np.ndarray | None
    symbols: dict[str, np.ndarray]

    @classmethod
    def of(cls, mushaf: Mushaf) -> Templates:
        ornament = line_images.separator_template(mushaf)
        return cls(
            ornament=ornament,
            ornament_array=prepare_template(ornament) if ornament is not None else None,
            symbols={
                name: prepare_template(image, name) for name, image in line_images.symbol_templates(mushaf).items()
            },
        )


@dataclass(frozen=True)
class Extraction:
    """One line measured over its full box, before anything is stored."""

    image: Image.Image
    #: The blob-id raster at the image's full size.
    raster: np.ndarray
    metadata: dict
    ink: LineInk


def extract_line(line: Line, rendered_page: Image.Image, templates: Templates) -> Extraction:
    """Measure one line exactly as the engine would, but uncut.

    The ornament spans come from the reviewed segments, as on the word run's own
    database path; the symbols are matched here because nothing upstream looked for
    them. What is kept is everything :func:`load` needs to rebuild the same
    ``LineInk`` without measuring again.
    """
    image, origin = line_images._image_for(line, rendered_page, None)
    width = templates.ornament.width if templates.ornament is not None else 0
    spans, ayat = line_images._separators(line, origin, image.width, width)
    source = LineImage(
        image,
        f"page-{line.page.page_number:04d}/line-{line.line_number:02d}",
        str(line.id),
        spans,
        ayat,
    )
    ink = analyse_line(source)
    # Every blob, taken before the partition: ornaments and symbols keep their ids
    # and their geometry, so the reviewer can see them on the raster.
    all_blobs = list(ink.components)
    split_symbols(ink, templates.symbols)
    split_separators(ink, templates.ornament_array)

    raster = np.zeros((image.height, image.width), dtype=np.int32)
    labels = ink.label_map
    raster[ink.offset_y : ink.offset_y + labels.shape[0], ink.offset_x : ink.offset_x + labels.shape[1]] = labels
    metadata = {
        "version": EXTRACTION_VERSION,
        "bbox": {"x": origin, "y": max(0, line.bbox_y), "w": image.width, "h": image.height},
        "source": source.source,
        "label": source.label,
        "blobs": [asdict(blob) for blob in all_blobs],
        "components": [blob.label for blob in ink.components],
        "separators": [[blob.label for blob in group] for group in ink.separators],
        "symbols": [[name, [blob.label for blob in group]] for name, group in ink.symbols],
        "separator_spans": ink.separator_spans,
        "separator_ayat": ink.separator_ayat,
        "symbol_spans": ink.symbol_spans,
        "band": list(ink.band),
        "peak": ink.peak,
        "offset_x": ink.offset_x,
        "offset_y": ink.offset_y,
        "segments": list(
            line.segments.order_by("segment_order").values(
                "bbox_x", "bbox_w", "aya_number", "has_separator", "segment_order"
            )
        ),
        "sura": line.sura_id,
    }
    return Extraction(image=image, raster=raster, metadata=metadata, ink=ink)


def snapshot_line(
    mushaf: Mushaf, line: Line, rendered_page: Image.Image | None = None, templates: Templates | None = None
) -> CalibrationSnapshot:
    """The line's snapshot, measured now only if its sources changed since the last.

    Idempotent per fingerprint: the same sources always return the same row, so the
    blob ids a reviewer labelled stay the ids the next preview sees.
    """
    fingerprint = source_fingerprint(line)
    existing = CalibrationSnapshot.objects.filter(mushaf=mushaf, fingerprint=fingerprint).first()
    if existing:
        return existing
    if rendered_page is None:
        rendered_page = line_images._render_page(mushaf, line.page)
    extraction = extract_line(line, rendered_page, templates or Templates.of(mushaf))
    snapshot = CalibrationSnapshot(
        mushaf=mushaf,
        page_number=line.page.page_number,
        line_number=line.line_number,
        source_line_id=line.id,
        fingerprint=fingerprint,
        metadata={**extraction.metadata, "source_fingerprint": fingerprint},
    )
    snapshot.image.save("image.png", ContentFile(png_bytes(extraction.image)), save=False)
    snapshot.labels.save("labels.png", ContentFile(png_bytes(encode_labels(extraction.raster))), save=False)
    snapshot.save()
    return snapshot


# ---------------------------------------------------------------------------
# Reading back
# ---------------------------------------------------------------------------
_BLOB_FIELDS = {f.name for f in fields(Blob)}


def _blob(raw: dict[str, Any]) -> Blob:
    # Fields added to Blob since the snapshot was taken take their defaults; ones
    # since removed are ignored, so an old snapshot never stops loading.
    return Blob(**{key: value for key, value in raw.items() if key in _BLOB_FIELDS})


def read_raster(snapshot: CalibrationSnapshot) -> np.ndarray:
    with snapshot.labels.open("rb") as handle:
        return decode_labels(Image.open(io.BytesIO(handle.read())))


def load(snapshot: CalibrationSnapshot) -> tuple[LineImage, LineInk]:
    """Rebuild the measured ``LineInk`` from storage, without measuring anything.

    Fresh ``Blob`` objects every call: the engine writes roles and locks onto the
    blobs it is handed, and a shared object would carry one preview into the next.
    """
    data = snapshot.metadata
    with snapshot.image.open("rb") as handle:
        image = Image.open(io.BytesIO(handle.read()))
        image.load()
    raster = read_raster(snapshot)
    dx, dy = data["offset_x"], data["offset_y"]
    rows, cols = np.where(raster > 0)
    tight = raster[dy : int(rows.max()) + 1, dx : int(cols.max()) + 1] if rows.size else raster
    blobs = {raw["label"]: _blob(raw) for raw in data["blobs"]}
    components = [blobs[ident] for ident in data["components"]]
    ink = LineInk(
        label=data["label"],
        source=data["source"],
        mask=tight > 0,
        offset_x=dx,
        offset_y=dy,
        peak=data["peak"],
        bodies=[b for b in components if b.preferred == "body"],
        marks=[b for b in components if b.preferred != "body"],
        components=components,
        band=(data["band"][0], data["band"][1]),
        separators=[[blobs[ident] for ident in group] for group in data["separators"]],
        separator_spans=[(span[0], span[1]) for span in data["separator_spans"]],
        separator_ayat=list(data["separator_ayat"]),
        symbols=[(name, [blobs[ident] for ident in group]) for name, group in data["symbols"]],
        symbol_spans=[(span[0], span[1]) for span in data["symbol_spans"]],
        label_map=tight,
    )
    # The line's source is the snapshot, so a constraint keyed by (source, label)
    # can only ever mean a blob of this exact measurement.
    return LineImage(image, data["label"], str(snapshot.pk)), ink


def select_span(ink: LineInk, metadata: dict, start: tuple[int, int], end: tuple[int, int]) -> list[int]:
    """Keep only the blobs of the ayat ``start``..``end``; return those cut by an edge.

    Selection is by **overlap with the span's segments**, and a blob is never split:
    one that reaches across the span's edge stays whole and is returned, so the
    reviewer is told rather than shown half a letter. The ornament spans are filtered
    the same way, since a parser event outside the span would close an aya it does
    not hold.
    """
    segments = [
        s
        for s in metadata["segments"]
        if s["aya_number"] is not None and start <= (metadata["sura"], s["aya_number"]) <= end
    ]
    if not segments:
        ink.components, ink.bodies, ink.marks = [], [], []
        ink.separators, ink.separator_spans, ink.separator_ayat = [], [], []
        return []
    origin = metadata["bbox"]["x"] + ink.offset_x
    left = min(s["bbox_x"] for s in segments) - origin
    right = max(s["bbox_x"] + s["bbox_w"] for s in segments) - origin
    selected = [b for b in ink.components if b.right > left and b.x < right]
    ink.components = selected
    ink.bodies = [b for b in selected if b.preferred == "body"]
    ink.marks = [b for b in selected if b.preferred != "body"]
    keep = [i for i, span in enumerate(ink.separator_spans) if span[1] > left and span[0] < right]
    ink.separator_spans = [ink.separator_spans[i] for i in keep]
    ink.separator_ayat = [ink.separator_ayat[i] for i in keep]
    ink.separators = [ink.separators[i] for i in keep]
    return [b.label for b in selected if b.x < left or b.right > right]


# ---------------------------------------------------------------------------
# What the matcher compares
# ---------------------------------------------------------------------------
#: Per-snapshot descriptors, by snapshot id. A snapshot never changes, so neither
#: do its descriptors; bounded because a line's are ~270 KB.
_FEATURES: OrderedDict[tuple[str, int], dict[int, np.ndarray]] = OrderedDict()
_FEATURES_MAX = 256


def blob_features(snapshot: CalibrationSnapshot) -> dict[int, np.ndarray]:
    """Every text blob's matcher descriptor, by blob id.

    Computed from the stored raster rather than stored itself: a descriptor is 1,030
    numbers, a page holds ~1,000 blobs, and it is fully determined by pixels the
    snapshot already keeps.
    """
    key = (str(snapshot.pk), FEATURE_VERSION)
    cached = _FEATURES.get(key)
    if cached is not None:
        _FEATURES.move_to_end(key)
        return cached
    data = snapshot.metadata
    raster = read_raster(snapshot)
    dx, dy = data["offset_x"], data["offset_y"]
    band_height = max(1, data["band"][1] - data["band"][0] + 1)
    text = set(data["components"])
    found: dict[int, np.ndarray] = {}
    for raw in data["blobs"]:
        if raw["label"] not in text:
            continue
        x, y = raw["x"] + dx, raw["y"] + dy
        mask = raster[y : y + raw["h"], x : x + raw["w"]] == raw["label"]
        found[raw["label"]] = np.asarray(
            feature_vector(
                mask,
                w=raw["w"],
                h=raw["h"],
                area=raw["area"],
                band_height=band_height,
                peak_offset=raw["y"] + raw["h"] / 2 - data["peak"],
            ),
            dtype=np.float32,
        )
    _FEATURES[key] = found
    while len(_FEATURES) > _FEATURES_MAX:
        _FEATURES.popitem(last=False)
    return found

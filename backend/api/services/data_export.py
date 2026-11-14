"""The full data export, schema ``mushaf-export/v2``: every line, aya, word and blob of
a mushaf, placed in page pixels *and* in its line PNG's own pixels, with two maps per
line saying which word, and which blob, each pixel of ink belongs to.

Inside the zip::

    README.txt                              how to read the rest
    manifest.json                           the mushaf, the conventions, one entry per page
    pages/page-0002.json                    a page: its lines, each with ayat, words, blobs
    lines/page-0002/line-03.png             the exported line image, as lines.zip has it
    maps/words/page-0002/line-03.png        each ink pixel → its word
    maps/blobs/page-0002/line-03.png        each ink pixel → its blob

**Two coordinate spaces, everywhere.** Every rectangle comes twice, ``page`` and
``png``, each ``[x, y, w, h]`` with y running down:

* ``page`` — pixels of the page image rendered at 300 dpi: the space the tool works in,
  and the one ``coordinates.json`` (aya-bbox/v1) uses;
* ``png`` — pixels of that line's exported PNG. The PNG is the page cut at the text
  column and the line's height (``png.crop``, in page pixels), set at ``png.offset`` on
  a canvas of ``png.size``; the offset is non-zero only when *uniform size* pads every
  line of a page to its largest. So ``png_x = page_x - crop_x + offset_x``, and so for y.

**Where words and blobs come from.** A page calibrated in Calibrate exports its draft
as it stands — every blob with its class, its mark type and its words, and the words'
boxes — and says how far it got (``calibration.state``): ``confirmed`` (approved, and
unchanged since), ``edited`` (approved, then changed) or ``draft`` (processed, never
approved: nobody has checked it). A page never calibrated exports whatever word boxes
are stored for it — from older data, or a bundle — and no blobs (``none``). The export hides nothing; which
states a downstream app trusts is its own call.

**The maps** are RGB PNGs the size of the line PNG, each pixel a number
``R + 256·G + 65536·B``, 0 for background — an encoding a browser canvas reads back
exactly. The word map's ``k`` is the line's ``words[k-1]``; the blob map's is the ``id``
of one of the line's ``blobs``. A blob two words share is split between them at their
boxes. The maps mark ink as the engine measured it, so the faint anti-aliased fringe
of a letter in the PNG may read as background.

Streamed: each page is written to the response as soon as it is made, so a whole
mushaf never sits in memory, and the download starts at once.
"""

from __future__ import annotations

import bisect
import copy
import io
import json
import logging
import uuid
import zipfile
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import numpy as np
from django.db.models import Prefetch
from ninja.errors import HttpError
from PIL import Image

from accounts.models import User
from api import i18n
from api.models import CalibrationReview, CalibrationSnapshot, Line, LineWord, Mushaf, Page, Segment
from api.services import calibration, coordinates, pdf, word_inputs
from api.services import calibration_marks as text_marks
from api.services import calibration_snapshots as snapshots
from api.services import mushaf as mushaf_service
from api.services.export import _safe_filename
from quran.models import Aya

logger = logging.getLogger(__name__)

Doc = dict[str, Any]

SCHEMA = "mushaf-export/v2"
#: Who set a text blob's class, in the export's own words.
SET_BY = {"human": "person", "text": "text", "calibration": "learning", "search": "engine"}
#: JSON compresses tenfold; PNGs are compressed already, so they are only wrapped.
JSON_LEVEL, PNG_LEVEL = 6, 1

README = """\
Mushaf export, schema mushaf-export/v2
======================================

manifest.json                         the mushaf, the conventions, one entry per page
pages/page-NNNN.json                  a page: lines, each with ayat, words and blobs
lines/page-NNNN/line-NN.png           the exported line images (as in lines.zip)
maps/words/page-NNNN/line-NN.png      pixel -> word, the same size as the line PNG
maps/blobs/page-NNNN/line-NN.png      pixel -> blob, the same size as the line PNG

Every rectangle is given twice, as [x, y, w, h] with y running down:
  "page"  pixels of the page rendered at 300 dpi (the space of coordinates.json, v1)
  "png"   pixels of the line's PNG:  png_x = page_x - crop_x + offset_x  (and so for y),
          crop and offset being the line's png.crop and png.offset

A blob is one connected piece of ink. Its class is "body" (part of a letter), "mark"
(anything above, below or beside the letters), "ornament" (an aya-end ring; "aya"
names the aya it closes) or "symbol" (a sajda or rub' sign; "symbol" names it). A mark
may carry a "type" (fatha, kasra, sukun, shadda, ...; two types joined by "+" are two
marks printed as one blob), set by a person or by the Quran text ("type_by"). "words"
lists the word ids a blob belongs to; "paws" is how many pieces of its word a body is.
A body flagged "mixed" holds a mark printed touching it; "marks" names them.
A blob marked "erased" is no ink of the text - noise a person erased: it belongs to no
word, and the line PNG and both maps are cut without it.

A map pixel holds R + 256*G + 65536*B, 0 for background. In a word map, k means the
line's words[k-1]; in a blob map, the blob whose "id" it is.

Each page says how far its calibration got: "confirmed" (approved, unchanged since),
"edited" (approved, then changed), "draft" (processed, never approved - unchecked), or
"none" (never calibrated: word boxes only, no blobs). "stale": the page's lines changed
after it was processed. Export the line images again after editing lines, or a PNG's
placement may no longer match it ("png.outdated" says when its size does not, or when
it was cut with other erases than the page has now).
"""


# ---------------------------------------------------------------------------
# Placing things in the two coordinate spaces
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _Placement:
    """Where one line's PNG was cut from the page, and where that cut sits in the PNG.

    The same arithmetic as ``export.export_lines``: the page cut at the text column and
    the line's top and height, clipped to the page, then centred on the page's largest
    line when *uniform size* is on.
    """

    left: int
    top: int
    width: int
    height: int
    offset_x: int = 0
    offset_y: int = 0
    canvas: tuple[int, int] = (0, 0)

    def rect(self, x: int, y: int, w: int, h: int) -> Doc:
        return {
            "page": [int(x), int(y), int(w), int(h)],
            "png": [int(x - self.left + self.offset_x), int(y - self.top + self.offset_y), int(w), int(h)],
        }

    def describe(self) -> Doc:
        return {
            "size": list(self.canvas),
            "crop": [self.left, self.top, self.width, self.height],
            "offset": [self.offset_x, self.offset_y],
        }


def _placements(mushaf: Mushaf, page: Page, lines: list[Line], size: tuple[int, int] | None) -> dict[Any, _Placement]:
    column = coordinates.page_column(page)
    cuts: dict[Any, tuple[int, int, int, int]] = {}
    for line in lines:
        col_x = column["x"] if column else line.bbox_x
        col_w = column["w"] if column else line.bbox_w
        left, top = max(0, col_x), max(0, line.bbox_y)
        right, bottom = col_x + col_w, line.bbox_y + line.bbox_h
        if size is not None:
            right, bottom = min(size[0], right), min(size[1], bottom)
        cuts[line.pk] = (left, top, max(0, right - left), max(0, bottom - top))
    canvas: tuple[int, int] | None = None
    if mushaf.export_uniform_size and cuts:
        canvas = (max(cut[2] for cut in cuts.values()), max(cut[3] for cut in cuts.values()))
    placed = {}
    for key, (left, top, width, height) in cuts.items():
        own = canvas or (width, height)
        placed[key] = _Placement(
            left, top, width, height, (own[0] - width) // 2, (own[1] - height) // 2, (own[0], own[1])
        )
    return placed


# ---------------------------------------------------------------------------
# What every page needs to know
# ---------------------------------------------------------------------------
@dataclass
class _Context:
    mushaf: Mushaf
    #: ``(start word id, sura, aya)`` of every aya in the mushaf's counting system.
    ayat: list[tuple[int, int, int]]
    #: Each PDF page's pixel size, by physical index.
    sizes: dict[int, tuple[int, int]]
    #: Mark types found, with how many of each.
    types: Counter[str]

    @classmethod
    def of(cls, mushaf: Mushaf) -> _Context:
        try:
            system = word_inputs.counting_system_for(mushaf)
        except LookupError:
            system = None
        ayat = (
            [
                (int(start), int(sura), int(number))
                for start, sura, number in Aya.objects.filter(counting_system=system)
                .order_by("start_word_id")
                .values_list("start_word_id", "sura_id", "number")
            ]
            if system is not None
            else []
        )
        try:
            sizes = pdf.page_sizes(mushaf.pdf_file.path)
        except Exception:  # an unreadable PDF costs the page sizes, never the export
            logger.warning("Export of %s: could not read page sizes from its PDF", mushaf.pk, exc_info=True)
            sizes = {}
        return cls(mushaf, ayat, sizes, Counter())

    def ref(self, word_id: int | None) -> str | None:
        """``sura:aya:n`` — the word's place in its aya, in this mushaf's counting."""
        if word_id is None or not self.ayat:
            return None
        at = bisect.bisect_right(self.ayat, (word_id, 10**6, 10**6)) - 1
        if at < 0:
            return None
        start, sura, number = self.ayat[at]
        return f"{sura}:{number}:{word_id - start + 1}"

    def size_of(self, page: Page) -> tuple[int, int] | None:
        index = pdf.logical_to_pdf_index(self.mushaf.first_quran_pdf_page, page.page_number, page.source_pdf_page)
        return self.sizes.get(index)


# ---------------------------------------------------------------------------
# One page
# ---------------------------------------------------------------------------
def _calibration_state(mushaf: Mushaf, review: CalibrationReview | None, rows: list[Doc]) -> Doc:
    if review is None or not rows:
        return {"state": "none"}
    if review.confirmed_revision is None:
        state = "draft"
    else:
        state = "confirmed" if review.confirmed_revision == review.revision else "edited"
    return {
        "state": state,
        "revision": review.revision,
        "confirmed_revision": review.confirmed_revision,
        "stale": not calibration._sources_current(mushaf, rows),
    }


def _type_of(blob: Doc) -> tuple[str, str] | None:
    """A mark's type and who set it: a person, or the Quran text. A type only guessed
    and never accepted is no type at all."""
    if blob["role"] != "mark" or not blob.get("subtype"):
        return None
    if text_marks.human_typed(blob):
        return blob["subtype"], "person"
    if blob.get("subtype_source") == "text":
        return blob["subtype"], "text"
    return None


def _structure(snapshot: CalibrationSnapshot | None) -> tuple[dict[int, str], dict[int, str]]:
    """Which aya each ornament blob closes, and which sign each symbol blob is."""
    if snapshot is None:
        return {}, {}
    data = snapshot.metadata
    ornaments = {
        ident: aya
        for group, aya in zip(data["separators"], data.get("separator_ayat", []), strict=False)
        for ident in group
    }
    symbols = {ident: name for name, group in data["symbols"] for ident in group}
    return ornaments, symbols


def _blob(blob: Doc, place: _Placement, ornaments: dict[int, str], symbols: dict[int, str], types: Counter[str]) -> Doc:
    role = blob["role"]
    entry: Doc = {
        "id": blob["id"],
        "class": role,
        "box": place.rect(blob["x"], blob["y"], blob["w"], blob["h"]),
        "area": blob["area"],
    }
    if role in calibration.TEXT_ROLES:
        allocations = blob.get("allocations") or []
        entry["words"] = [allocation["word_id"] for allocation in allocations]
        if role == "body":
            entry["paws"] = sum(allocation["paws"] for allocation in allocations)
            if fused := text_marks.fused_marks(blob):
                # Marks printed touching the letter, one blob with it, as a person named them.
                entry["marks"] = fused
        typed = _type_of(blob)
        if role == "mark":
            entry["type"], entry["type_by"] = typed if typed else (None, None)
            if typed:
                types[typed[0]] += 1
        entry["set_by"] = SET_BY.get(blob.get("decision_source", "search"), "engine")
        if blob.get("exception"):
            entry["flag"] = blob["exception"]
        if blob.get("erased"):
            entry["erased"] = True
    elif role == "ornament":
        entry["aya"] = ornaments.get(blob["id"]) or None
    elif role == "symbol":
        entry["symbol"] = symbols.get(blob["id"])
    return entry


def _ink_boxes(row: Doc, words: dict[int, Doc]) -> dict[int, list[int]]:
    """Each word's ink, tight: the union of its blobs, a shared one cut at the word's box."""
    boxes: dict[int, list[int]] = {}
    for blob in row["blobs"]:
        if blob["role"] not in calibration.TEXT_ROLES:
            continue
        owners = [allocation["word_id"] for allocation in blob.get("allocations") or []]
        for owner in owners:
            left, right = blob["x"], blob["x"] + blob["w"]
            word = words.get(owner)
            if len(owners) > 1 and word is not None:
                left, right = max(left, word["end_x"]), min(right, word["start_x"])
                if right <= left:
                    continue
            box = boxes.get(owner)
            top, bottom = blob["y"], blob["y"] + blob["h"]
            boxes[owner] = (
                [left, top, right, bottom]
                if box is None
                else [min(box[0], left), min(box[1], top), max(box[2], right), max(box[3], bottom)]
            )
    return boxes


def _encode(values: np.ndarray) -> bytes:
    return snapshots.png_bytes(snapshots.encode_labels(values))


def _laid(snapshot: CalibrationSnapshot, place: _Placement) -> np.ndarray:
    """The line's blob ids laid exactly over its PNG, the PNG's size."""
    raster = snapshots.read_raster(snapshot)
    width, height = place.canvas
    ids = np.zeros((height, width), dtype=np.int32)
    origin = snapshot.metadata["bbox"]
    dx = origin["x"] - place.left + place.offset_x
    dy = origin["y"] - place.top + place.offset_y
    sx, sy = max(0, -dx), max(0, -dy)
    tx, ty = max(0, dx), max(0, dy)
    w = min(raster.shape[1] - sx, width - tx)
    h = min(raster.shape[0] - sy, height - ty)
    if w > 0 and h > 0:
        ids[ty : ty + h, tx : tx + w] = raster[sy : sy + h, sx : sx + w]
    return ids


def _maps(row: Doc, snapshot: CalibrationSnapshot, place: _Placement, words: list[Doc]) -> tuple[bytes, bytes]:
    """The line's word map and blob map, laid exactly over its PNG — without the ink a
    person erased, which the PNG is cut without."""
    ids = _laid(snapshot, place)
    erased = [blob["id"] for blob in row["blobs"] if blob.get("erased")]
    if erased:
        ids[np.isin(ids, erased)] = 0

    position = {word["word_id"]: index + 1 for index, word in enumerate(words) if word["word_id"] is not None}
    edges = {word["word_id"]: (word["end_x"], word["start_x"]) for word in words if word["word_id"] is not None}
    lookup = np.zeros(int(ids.max()) + 1, dtype=np.int32)
    shared: list[tuple[int, list[int]]] = []
    for blob in row["blobs"]:
        if blob["role"] not in calibration.TEXT_ROLES or blob["id"] >= lookup.size:
            continue
        owners = [a["word_id"] for a in blob.get("allocations") or [] if a["word_id"] in position]
        if len(owners) == 1:
            lookup[blob["id"]] = position[owners[0]]
        elif owners:
            shared.append((blob["id"], owners))
    word_map = lookup[ids]
    for ident, owners in shared:
        rows, cols = np.nonzero(ids == ident)
        if not rows.size:
            continue
        # Each pixel to the owner whose box holds it — or, in a gap, the nearest one.
        page_x = cols + place.left - place.offset_x
        distance = np.stack(
            [np.maximum(0, np.maximum(edges[owner][0] - page_x, page_x - edges[owner][1] + 1)) for owner in owners]
        )
        chosen = np.asarray([position[owner] for owner in owners], dtype=np.int32)[np.argmin(distance, axis=0)]
        word_map[rows, cols] = chosen
    return _encode(word_map), _encode(ids)


def _cut_otherwise(line: Line, row: Doc, snapshot: CalibrationSnapshot, place: _Placement, data: bytes | None) -> bool:
    """Whether a line's stored PNG was cut with other erases than its draft has now: a
    blob erased since still shows in it, or one restored since is still cut out of it.

    Read from the PNG's own pixels — an export stores nothing else about what it cut.
    Asked only of a current line that has had an erase, so a mushaf nobody erased in
    pays nothing for it.
    """
    erased = [blob["id"] for blob in row["blobs"] if blob.get("erased")]
    restored = [blob["id"] for blob in row["blobs"] if blob.get("erased") is False]
    try:
        if data is None:
            with line.line_png.open("rb") as handle:
                data = handle.read()
        with Image.open(io.BytesIO(data)) as image:
            alpha = np.asarray(image.convert("RGBA").getchannel("A"))
    except Exception:  # an unreadable PNG says nothing about its erases
        return False
    ids = _laid(snapshot, place)
    if alpha.shape != ids.shape:
        return True
    if erased and bool((alpha[np.isin(ids, erased)] > 0).any()):
        return True
    for ident in restored:
        shown = alpha[ids == ident]
        if shown.size and not (shown > 0).any():
            return True
    return False


def _words_of(row: Doc | None, line: Line) -> list[Doc]:
    """A line's words — from the calibration draft when it has the line, else the stored
    cuts — as ``word_id``, ``text`` and both edges, in reading order."""
    if row is not None:
        return [
            {
                "word_id": word["word_id"],
                "text": word.get("text", ""),
                "start_x": word["start_x"],
                "end_x": word["end_x"],
            }
            for word in row["words"]
        ]
    return [
        {
            "word_id": cut.word_id,
            "text": cut.word.text if cut.word is not None else "",
            "start_x": cut.start_x,
            "end_x": cut.end_x,
        }
        for cut in line.words.all()
    ]


def _line_png(line: Line, *, include: bool) -> tuple[bytes | None, tuple[int, int] | None]:
    """The stored line PNG's size, and its bytes when they are to go in the zip.
    ``(None, None)`` for a line never exported, or whose file has gone missing."""
    name = line.line_png.name if line.line_png else ""
    if not name or not line.line_png.storage.exists(name):
        return None, None
    with line.line_png.open("rb") as handle:
        data = handle.read() if include else None
        try:
            # Only the header is read when the bytes are not wanted.
            with Image.open(io.BytesIO(data) if data is not None else handle) as image:
                size: tuple[int, int] | None = image.size
        except Exception:  # a header that does not parse says nothing about placement
            size = None
    return data, size


def _page(context: _Context, page: Page, *, images: bool, maps: bool) -> tuple[Doc, list[tuple[str, bytes]]]:
    """One page's document, and the files that go beside it."""
    mushaf = context.mushaf
    lines = list(
        page.lines.order_by("line_number").prefetch_related(
            Prefetch("segments", queryset=Segment.objects.order_by("segment_order")),
            Prefetch("words", queryset=LineWord.objects.select_related("word").order_by("position")),
        )
    )
    size = context.size_of(page)
    placed = _placements(mushaf, page, lines, size)
    review = CalibrationReview.objects.filter(mushaf=mushaf, page_number=page.page_number).first()
    rows = [copy.deepcopy(row) for row in (review.payload.get("lines") or [])] if review else []
    for row in rows:
        # Boxes hold their own marks — as the editor shows a draft, and a confirmation writes it.
        calibration._box_words(row)
    by_line = {row["line_number"]: row for row in rows}
    stored = {
        str(snapshot.pk): snapshot
        for snapshot in CalibrationSnapshot.objects.filter(mushaf=mushaf, pk__in=[row["snapshot_id"] for row in rows])
    }
    state = _calibration_state(mushaf, review, rows)

    files: list[tuple[str, bytes]] = []
    out_lines = []
    for line in lines:
        place = placed[line.pk]
        stem = f"page-{page.page_number:04d}/line-{line.line_number:02d}.png"
        data, png_size = _line_png(line, include=images)
        png: Doc = {"file": None, **place.describe(), "exported": png_size is not None}
        if png_size is not None:
            png["outdated"] = list(png_size) != list(place.canvas)
        if data is not None:
            png["file"] = f"lines/{stem}"
            files.append((png["file"], data))

        row = by_line.get(line.line_number)
        words = _words_of(row, line)
        by_id = {word["word_id"]: word for word in words if word["word_id"] is not None}
        ink = _ink_boxes(row, by_id) if row is not None else {}
        snapshot = stored.get(row["snapshot_id"]) if row is not None else None
        if (
            png.get("outdated") is False
            and row is not None
            and snapshot is not None
            and not state.get("stale")
            and any("erased" in blob for blob in row["blobs"])
        ):
            png["outdated"] = _cut_otherwise(line, row, snapshot, place, data)
        ornaments, symbols = _structure(snapshot)
        blob_ids: dict[int, list[int]] = {}
        for blob in row["blobs"] if row is not None else []:
            if blob["role"] in calibration.TEXT_ROLES:
                for allocation in blob.get("allocations") or []:
                    blob_ids.setdefault(allocation["word_id"], []).append(blob["id"])

        entry: Doc = {
            "line": line.line_number,
            "type": line.type,
            "sura": line.sura_id,
            "box": place.rect(line.bbox_x, line.bbox_y, line.bbox_w, line.bbox_h),
            "png": png,
            "ayat": [
                {
                    "sura": line.sura_id,
                    "aya": segment.aya_number,
                    "ends_here": segment.has_separator,
                    "box": place.rect(segment.bbox_x, line.bbox_y, segment.bbox_w, line.bbox_h),
                }
                for segment in line.segments.all()
                if segment.aya_number is not None
            ],
            "words": [
                {
                    "id": word["word_id"],
                    "ref": context.ref(word["word_id"]),
                    "text": word["text"],
                    "box": place.rect(word["end_x"], line.bbox_y, word["start_x"] - word["end_x"], line.bbox_h),
                    "ink": (
                        place.rect(box[0], box[1], box[2] - box[0], box[3] - box[1])
                        if (box := ink.get(word["word_id"])) is not None
                        else None
                    ),
                    **({"blobs": blob_ids.get(word["word_id"], [])} if row is not None else {}),
                }
                for word in words
            ],
            "blobs": (
                [_blob(blob, place, ornaments, symbols, context.types) for blob in row["blobs"]]
                if row is not None
                else []
            ),
            "maps": {"words": None, "blobs": None},
        }
        if maps and row is not None and snapshot is not None and place.canvas[0] and place.canvas[1]:
            word_map, blob_map = _maps(row, snapshot, place, words)
            entry["maps"] = {"words": f"maps/words/{stem}", "blobs": f"maps/blobs/{stem}"}
            files.append((entry["maps"]["words"], word_map))
            files.append((entry["maps"]["blobs"], blob_map))
        out_lines.append(entry)

    document = {
        "schema": SCHEMA,
        "page": page.page_number,
        "pdf_page": pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page.page_number, page.source_pdf_page),
        "size": list(size) if size else None,
        "reviewed": page.reviewed,
        "calibration": state,
        "lines": out_lines,
    }
    return document, files


# ---------------------------------------------------------------------------
# The archive
# ---------------------------------------------------------------------------
class _Sink(io.RawIOBase):
    """Where the zip is written as it is made. Not seekable, so ``zipfile`` writes each
    entry's sizes after its data, and every finished entry can be sent on at once."""

    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, data: Any) -> int:
        chunk = bytes(data)
        self._chunks.append(chunk)
        return len(chunk)

    def take(self) -> bytes:
        data = b"".join(self._chunks)
        self._chunks.clear()
        return data


def _manifest(context: _Context, entries: list[Doc], *, images: bool, maps: bool) -> Doc:
    mushaf = context.mushaf
    states = Counter(entry["calibration"] for entry in entries)
    return {
        "schema": SCHEMA,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "mushaf": {
            "id": str(mushaf.id),
            "name": mushaf.name,
            "qiraa": mushaf.rawi.name if mushaf.rawi else None,
            "pages": mushaf.last_quran_pdf_page - mushaf.first_quran_pdf_page + 1,
            "dpi": pdf.DEFAULT_DPI,
            "uniform_png_size": mushaf.export_uniform_size,
        },
        "contains": {"line_images": images, "maps": maps},
        "coordinates": {
            "rect": "[x, y, w, h], y running down",
            "page": f"pixels of the page image rendered at {pdf.DEFAULT_DPI} dpi",
            "png": "pixels of the line's PNG: png_x = page_x - png.crop[0] + png.offset[0], and so for y",
        },
        "maps": {
            "encoding": "RGB PNG the size of the line PNG; value = R + 256*G + 65536*B, 0 = background",
            "words": "value k = the line's words[k-1]",
            "blobs": "value = the id of one of the line's blobs",
        },
        "classes": {
            "body": "part of a letter",
            "mark": "anything above, below or beside the letters — see types",
            "ornament": "an aya-end ring; 'aya' names the aya it closes",
            "symbol": "a sajda or rub' sign; 'symbol' names it",
        },
        "types": dict(sorted(context.types.items(), key=lambda item: (-item[1], item[0]))),
        "calibration_states": {
            "confirmed": "approved in Calibrate, and unchanged since",
            "edited": "approved, then changed",
            "draft": "processed for calibration, never approved — nobody has checked it",
            "none": "never calibrated: word boxes only, no blobs",
        },
        "totals": {
            "pages": len(entries),
            "lines": sum(entry["lines"] for entry in entries),
            "words": sum(entry["words"] for entry in entries),
            "blobs": sum(entry["blobs"] for entry in entries),
            "by_calibration": dict(states),
        },
        "pages": entries,
    }


def _summary(document: Doc, name: str) -> Doc:
    return {
        "page": document["page"],
        "file": name,
        "calibration": document["calibration"]["state"],
        "stale": bool(document["calibration"].get("stale")),
        "lines": len(document["lines"]),
        "words": sum(len(line["words"]) for line in document["lines"]),
        "blobs": sum(len(line["blobs"]) for line in document["lines"]),
    }


def archive(
    mushaf_id: uuid.UUID,
    *,
    user: User | None,
    page_number: int | None = None,
    images: bool = True,
    maps: bool = True,
) -> tuple[str, Iterator[bytes]]:
    """The export's filename, and its bytes as they are made — the whole mushaf, or one
    page. Everything that can refuse does so here, before the first byte is sent."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user, write=False)
    pages = Page.objects.filter(mushaf=mushaf).order_by("page_number")
    if page_number is not None:
        pages = pages.filter(page_number=page_number)
    numbers = list(pages.values_list("page_number", flat=True))
    if not numbers:
        if page_number is not None:
            raise HttpError(404, i18n.t("page_not_found", page=page_number))
        raise HttpError(404, i18n.t("export_nothing"))
    suffix = f"-p{page_number:04d}" if page_number is not None else ""
    return f"{_safe_filename(mushaf.name)}{suffix}-export.zip", _chunks(mushaf, numbers, images=images, maps=maps)


def _chunks(mushaf: Mushaf, numbers: list[int], *, images: bool, maps: bool) -> Iterator[bytes]:
    sink = _Sink()
    context = _Context.of(mushaf)
    entries: list[Doc] = []
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED, compresslevel=JSON_LEVEL) as zipped:
        zipped.writestr("README.txt", README)
        for number in numbers:
            page = Page.objects.filter(mushaf=mushaf, page_number=number).first()
            if page is None:
                continue  # deleted while the export ran
            document, files = _page(context, page, images=images, maps=maps)
            name = f"pages/page-{number:04d}.json"
            zipped.writestr(name, json.dumps(document, ensure_ascii=False, separators=(",", ":")))
            for path, data in files:
                zipped.writestr(path, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=PNG_LEVEL)
            entries.append(_summary(document, name))
            yield sink.take()
        zipped.writestr(
            "manifest.json",
            json.dumps(_manifest(context, entries, images=images, maps=maps), ensure_ascii=False, indent=2),
        )
    yield sink.take()

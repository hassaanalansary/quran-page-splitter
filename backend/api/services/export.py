"""Export final transparent line PNGs from a page's coordinates + erase strokes.

Each line is cropped from the freshly rendered page, its white background is
made transparent, eraser strokes are punched out of the alpha channel, and the
PNG is saved to ``media/lines/`` with its path recorded on the line.

``lines_zip`` bundles those stored PNGs into a downloadable archive — the way
the images leave the tool and land wherever the user wants them.
"""

import io
import shutil
import uuid
import zipfile
from tempfile import SpooledTemporaryFile

from django.core.files.base import ContentFile
from django.db.models import Prefetch
from ninja.errors import HttpError
from PIL import Image, ImageDraw

from api import i18n
from api.models import ActivityTypeChoices, Line, Page, Segment
from api.services import activity, coordinates, pdf
from api.services import mushaf as mushaf_service
from core.cut_review import _apply_eraser_stroke
from core.image_utils import make_transparent

#: Keep small archives in RAM; larger ones spill to a temp file on disk.
_ZIP_SPOOL_BYTES = 16 * 1024 * 1024


def export_lines(*, mushaf_id: uuid.UUID, page_number: int) -> dict:
    """Render the page, crop each line to a transparent PNG, and store its path."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    page = Page.objects.filter(mushaf=mushaf, page_number=page_number).first()
    if page is None:
        raise HttpError(404, i18n.t("page_no_export"))

    pdf_index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page_number, page.source_pdf_page)
    image = Image.open(io.BytesIO(pdf.render_page(mushaf.pdf_file.path, pdf_index)))
    image.load()

    column = coordinates.page_column(page)
    exported: list[dict] = []
    for line in page.lines.order_by("line_number").prefetch_related("erase_strokes"):
        png_bytes = _render_line_png(image, line, column)
        filename = f"{mushaf.id}_p{page_number:04d}_l{line.line_number:02d}.png"
        if line.line_png:
            line.line_png.delete(save=False)
        line.line_png.save(filename, ContentFile(png_bytes), save=True)
        exported.append({"line_number": line.line_number, "line_png": line.line_png.url})

    activity.emit(mushaf, ActivityTypeChoices.LINES_EXPORTED, {"page_number": page_number, "exported": len(exported)})
    return {"page_number": page_number, "exported": len(exported), "lines": exported}


def lines_zip(*, mushaf_id: uuid.UUID, page_number: int | None = None) -> tuple[str, SpooledTemporaryFile]:
    """Bundle the exported line PNGs into a zip, ready to stream as a download.

    One whole mushaf or a single logical page. Entries are laid out as
    ``page-0007/line-03.png`` so the archive stays sorted and page-grouped
    wherever it is unpacked. Only lines that were actually exported are
    included — nothing is rendered here.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    lines = (
        Line.objects.filter(page__mushaf=mushaf)
        .exclude(line_png="")
        .select_related("page")
        .order_by("page__page_number", "line_number")
    )
    if page_number is not None:
        lines = lines.filter(page__page_number=page_number)

    # Deliberately not a context manager: the caller streams this file out as the
    # response body and closes it when the download finishes.
    buffer: SpooledTemporaryFile = SpooledTemporaryFile(max_size=_ZIP_SPOOL_BYTES)  # noqa: SIM115
    written = 0
    # Already-compressed PNGs: storing them is much faster and no bigger.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for line in lines:
            name = line.line_png.name
            if not name or not line.line_png.storage.exists(name):
                continue  # media file went missing — skip rather than fail the download
            arcname = f"page-{line.page.page_number:04d}/line-{line.line_number:02d}.png"
            with line.line_png.open("rb") as source, archive.open(arcname, "w") as target:
                shutil.copyfileobj(source, target)
            written += 1

    if not written:
        buffer.close()
        raise HttpError(404, i18n.t("lines_no_export"))

    buffer.seek(0)
    stem = _safe_filename(mushaf.name)
    suffix = f"-p{page_number:04d}" if page_number is not None else ""
    return f"{stem}{suffix}-lines.zip", buffer


def coordinates_json(mushaf_id: uuid.UUID) -> tuple[str, dict]:
    """Assemble the downloadable aya-coordinates document (schema ``aya-bbox/v1``).

    One entry per aya per page, in reading order (line by line, right-to-left
    within a line). An aya's rects are its segments' boxes: x/w from the segment,
    y/h from the segment's line. Pages without aya data are omitted.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    pages = (
        Page.objects.filter(mushaf=mushaf)
        .order_by("page_number")
        .prefetch_related(
            Prefetch(
                "lines",
                queryset=Line.objects.order_by("line_number").prefetch_related(
                    Prefetch("segments", queryset=Segment.objects.order_by("segment_order"))
                ),
            )
        )
    )
    pages_out = []
    for page in pages:
        ayas: dict[tuple[int, int], dict] = {}
        for line in page.lines.all():
            if line.sura_id is None:
                continue
            for segment in line.segments.all():
                if segment.aya_number is None:
                    continue
                entry = ayas.setdefault(
                    (line.sura_id, segment.aya_number),
                    {"sura": line.sura_id, "aya": segment.aya_number, "rects": []},
                )
                entry["rects"].append({"x": segment.bbox_x, "y": line.bbox_y, "w": segment.bbox_w, "h": line.bbox_h})
        if ayas:
            pages_out.append({"page": page.page_number, "ayas": list(ayas.values())})

    doc = {
        "schema": "aya-bbox/v1",
        "mushaf": {
            "id": str(mushaf.id),
            "name": mushaf.name,
            "qiraa": mushaf.qiraa.name if mushaf.qiraa else None,
            "pages": mushaf.last_quran_pdf_page - mushaf.first_quran_pdf_page + 1,
        },
        "pages": pages_out,
    }
    return f"{_safe_filename(mushaf.name)}-coordinates.json", doc


def _safe_filename(name: str) -> str:
    """A header-safe download filename stem (alnum/dash/underscore only)."""
    cleaned = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.strip())
    return cleaned.strip("-") or "mushaf"


def _render_line_png(image: Image.Image, line: Line, column: dict | None) -> bytes:
    # The line cut spans the page's text-column bounds (coordinates.page_column);
    # the line's own x/w track content extent (from segments) and are left
    # untouched. Only the vertical extent (Y/H) comes from the line.
    col_x = column["x"] if column else line.bbox_x
    col_w = column["w"] if column else line.bbox_w
    left = max(0, col_x)
    top = max(0, line.bbox_y)
    right = min(image.width, col_x + col_w)
    bottom = min(image.height, line.bbox_y + line.bbox_h)
    rgba = make_transparent(image.crop((left, top, right, bottom)))

    strokes = list(line.erase_strokes.all())
    if strokes:
        alpha = rgba.getchannel("A")
        draw = ImageDraw.Draw(alpha)
        for stroke in strokes:
            _apply_eraser_stroke(
                draw,
                {"brush_size": stroke.brush_size, "points": stroke.points},
                left,
                top,
            )
        rgba.putalpha(alpha)

    buffer = io.BytesIO()
    rgba.save(buffer, format="PNG")
    return buffer.getvalue()

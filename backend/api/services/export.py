"""Export final transparent line PNGs from a page's coordinates + erase strokes.

Each line is cropped from the freshly rendered page, its white background is
made transparent, eraser strokes are punched out of the alpha channel — and so,
pixel for pixel, is every blob a person erased in Calibrate, and on a line with
``erase_edge_ink`` every piece of ink reaching over its top or bottom edge — and the
PNG is saved under ``media/mushafs/<id>/lines/`` with its path recorded on
the line. ``Mushaf.line_png_size`` then sets its height: the line's own box; or
centred on a transparent canvas the size of that page's largest line, so the whole
page exports at one size; or cut down to its first and last inked row, with the
rows cut off recorded on the line so its place on the page can still be told; or
cut so first and then centred on a canvas the size of the page's tallest cut line.

``lines_zip`` bundles those stored PNGs into a downloadable archive — the way
the images leave the tool and land wherever the user wants them.
"""

import io
import shutil
import uuid
import zipfile
from tempfile import SpooledTemporaryFile

import numpy as np
from django.core.files.base import ContentFile
from django.db.models import Prefetch
from ninja.errors import HttpError
from PIL import Image, ImageDraw

from accounts.models import User
from api import i18n
from api.models import INK_CROPPED_PNG_SIZES, PAGE_SIZED_PNG_SIZES, ActivityTypeChoices, Line, Page, Segment
from api.services import activity, coordinates, pdf
from api.services import mushaf as mushaf_service
from core.imaging import apply_eraser_stroke, find_edge_ink, find_ink, make_transparent

#: Keep small archives in RAM; larger ones spill to a temp file on disk.
_ZIP_SPOOL_BYTES = 16 * 1024 * 1024


def export_lines(*, user: User, mushaf_id: uuid.UUID, page_number: int) -> dict:
    """Render the page, crop each line to a transparent PNG, and store its path."""
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user)
    page = mushaf_service.get_page(mushaf, page_number, message="page_no_export")

    pdf_index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page_number, page.source_pdf_page)
    image = Image.open(io.BytesIO(pdf.render_page(mushaf.pdf_file.path, pdf_index)))
    image.load()

    column = coordinates.page_column(page)
    lines = list(page.lines.order_by("line_number").prefetch_related("erase_strokes"))
    # Imported here: calibration reaches this module through line_images.
    from api.services import calibration

    # Blobs a person erased in Calibrate — noise the cutting left — go too.
    erased = calibration.erased_ink(mushaf, page_number, lines)

    # Rendered up front rather than streamed one at a time: a page-sized canvas can
    # only be sized once every line on the page has been cut, erased and (when
    # tight) cropped. Fifteen RGBA line crops is a manageable amount to hold.
    rendered = []
    for line in lines:
        rgba = render_line_image(image, line, column)
        if str(line.pk) in erased:
            cut_erased(rgba, _origin(line, column), erased[str(line.pk)])
        if line.erase_edge_ink:
            cut_edge_ink(rgba, image, line, column)
        trim_top = trim_bottom = 0
        if mushaf.line_png_size in INK_CROPPED_PNG_SIZES:
            rgba, trim_top, trim_bottom = crop_to_ink_rows(rgba)
        rendered.append((line, rgba, trim_top, trim_bottom))
    canvas: tuple[int, int] | None = None
    if mushaf.line_png_size in PAGE_SIZED_PNG_SIZES and rendered:
        canvas = (
            max(img.width for _, img, _, _ in rendered),
            max(img.height for _, img, _, _ in rendered),
        )

    exported: list[dict] = []
    for line, rgba, trim_top, trim_bottom in rendered:
        # Priming the FK cache keeps models.line_png_path from re-querying the
        # page (and through it the mushaf) once per line.
        line.page = page
        if canvas:
            rgba = _pad_to(rgba, canvas)
        # Saved with the PNG below (line_png.save saves the row).
        line.line_png_trim_top, line.line_png_trim_bottom = trim_top, trim_bottom
        png_bytes = _to_png_bytes(rgba)
        filename = f"page-{page_number:04d}/line-{line.line_number:02d}.png"
        if line.line_png:
            line.line_png.delete(save=False)
        line.line_png.save(filename, ContentFile(png_bytes), save=True)
        exported.append({"line_number": line.line_number, "line_png": line.line_png.url})

    activity.emit(
        mushaf,
        ActivityTypeChoices.LINES_EXPORTED,
        {"page_number": page_number, "exported": len(exported)},
        actor=user,
    )
    return {"page_number": page_number, "exported": len(exported), "lines": exported}


def lines_zip(
    *, user: User | None, mushaf_id: uuid.UUID, page_number: int | None = None
) -> tuple[str, SpooledTemporaryFile]:
    """Bundle the exported line PNGs into a zip, ready to stream as a download.

    One whole mushaf or a single logical page. Entries are laid out as
    ``page-0007/line-03.png`` so the archive stays sorted and page-grouped
    wherever it is unpacked. Only lines that were actually exported are
    included — nothing is rendered here.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user, write=False)
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


def coordinates_json(mushaf_id: uuid.UUID, *, user: User | None) -> tuple[str, dict]:
    """Assemble the downloadable aya-coordinates document (schema ``aya-bbox/v1``).

    One entry per aya per page, in reading order (line by line, right-to-left
    within a line). An aya's rects are its segments' boxes: x/w from the segment,
    y/h from the segment's line. Pages without aya data are omitted.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user, write=False)
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
            "qiraa": mushaf.rawi.name if mushaf.rawi else None,
            "pages": mushaf.last_quran_pdf_page - mushaf.first_quran_pdf_page + 1,
        },
        "pages": pages_out,
    }
    return f"{_safe_filename(mushaf.name)}-coordinates.json", doc


def _safe_filename(name: str) -> str:
    """A header-safe download filename stem (alnum/dash/underscore only)."""
    cleaned = "".join(c if c.isalnum() or c in "-_" else "-" for c in name.strip())
    return cleaned.strip("-") or "mushaf"


def _pad_to(rgba: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Centre ``rgba`` on a fully transparent canvas of ``size``.

    Padding only ever *adds* space — the caller sizes the canvas from the
    largest line on the page, so nothing can be cropped. Centring keeps the
    glyphs optically in the middle of their band, which is what reproduces the
    original page when the lines are stacked back up.
    """
    width, height = size
    if rgba.width == width and rgba.height == height:
        return rgba
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.paste(rgba, ((width - rgba.width) // 2, (height - rgba.height) // 2))
    return canvas


def crop_to_ink_rows(rgba: Image.Image) -> tuple[Image.Image, int, int]:
    """Cut a line image down to its first and last row with anything opaque left,
    and say how many rows came off the top and the bottom. The width is kept, so
    every line still spans the page column.

    A line with no ink left at all is returned whole: a PNG has to have a row.
    """
    rows = np.flatnonzero(np.asarray(rgba.getchannel("A")).any(axis=1))
    if rows.size == 0:
        return rgba, 0, 0
    top, last = int(rows[0]), int(rows[-1])
    return rgba.crop((0, top, rgba.width, last + 1)), top, rgba.height - 1 - last


def _to_png_bytes(rgba: Image.Image) -> bytes:
    buffer = io.BytesIO()
    rgba.save(buffer, format="PNG")
    return buffer.getvalue()


def render_line_image(image: Image.Image, line: Line, column: dict | None) -> Image.Image:
    """Crop one line out of a rendered page, make it transparent, punch the erasers out.

    Public because ``services.line_images`` needs the same crop to feed the
    word-boundary engine — a line whose PNG was never exported, or one that must
    line up with page coordinates, is cut here rather than read from disk.
    """
    left, top, right, bottom = line_crop_box(image, line, column)
    rgba = make_transparent(image.crop((left, top, right, bottom)))

    strokes = list(line.erase_strokes.all())
    if strokes:
        alpha = rgba.getchannel("A")
        draw = ImageDraw.Draw(alpha)
        for stroke in strokes:
            apply_eraser_stroke(
                draw,
                {"brush_size": stroke.brush_size, "points": stroke.points},
                left,
                top,
            )
        rgba.putalpha(alpha)

    return rgba


def line_crop_box(image: Image.Image, line: Line, column: dict | None) -> tuple[int, int, int, int]:
    """The (left, top, right, bottom) of the page a line image is cut from.

    The line cut spans the page's text-column bounds (coordinates.page_column);
    the line's own x/w track content extent (from segments) and are left
    untouched. Only the vertical extent (Y/H) comes from the line.
    """
    col_x = column["x"] if column else line.bbox_x
    col_w = column["w"] if column else line.bbox_w
    left, top = _origin(line, column)
    right = min(image.width, col_x + col_w)
    bottom = min(image.height, line.bbox_y + line.bbox_h)
    return left, top, right, bottom


def _origin(line: Line, column: dict | None) -> tuple[int, int]:
    """The page x and y of a line image's top-left pixel, as ``render_line_image`` cuts it."""
    return max(0, column["x"] if column else line.bbox_x), max(0, line.bbox_y)


def cut_edge_ink(rgba: Image.Image, image: Image.Image, line: Line, column: dict | None) -> None:
    """Punch out of a line image the ink of neighbouring lines reaching over its top
    or bottom edge (``core.imaging.edge_ink``). In place.

    Found on the line's raw cut of the page, before any brush stroke, so it does not
    depend on how a stroke is rasterised — the Finalize canvas runs the same rule on
    the same pixels to preview it, and must find exactly what this does.
    """
    edge = find_edge_ink(find_ink(image.crop(line_crop_box(image, line, column))))
    if not edge.any():
        return
    alpha = np.array(rgba.getchannel("A"))
    alpha[edge] = 0
    rgba.putalpha(Image.fromarray(alpha))


def cut_erased(rgba: Image.Image, origin: tuple[int, int], erased: tuple[np.ndarray, int, int]) -> None:
    """Punch the ink a person erased in Calibrate out of a line image's alpha. In place.

    ``erased`` is ``calibration.erased_ink``'s: a mask and the page x and y of its
    top-left; ``origin`` is the image's own. Exact to the pixel, unlike a brush stroke —
    and kept out of ``render_line_image``, which also feeds the snapshots the erase was
    made on.
    """
    mask, x, y = erased
    alpha = np.array(rgba.getchannel("A"))
    dx, dy = x - origin[0], y - origin[1]
    sx, sy, tx, ty = max(0, -dx), max(0, -dy), max(0, dx), max(0, dy)
    width = min(mask.shape[1] - sx, alpha.shape[1] - tx)
    height = min(mask.shape[0] - sy, alpha.shape[0] - ty)
    if width <= 0 or height <= 0:
        return
    alpha[ty : ty + height, tx : tx + width][mask[sy : sy + height, sx : sx + width]] = 0
    rgba.putalpha(Image.fromarray(alpha))

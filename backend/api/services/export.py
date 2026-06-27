"""Export final transparent line PNGs from a page's coordinates + erase strokes.

Each line is cropped from the freshly rendered page, its white background is
made transparent, eraser strokes are punched out of the alpha channel, and the
PNG is saved to ``media/lines/`` with its path recorded on the line.
"""

import io
import uuid

from django.core.files.base import ContentFile
from ninja.errors import HttpError
from PIL import Image, ImageDraw

from api.models import Line, Page
from api.services import mushaf as mushaf_service
from api.services import pdf
from core.cut_review import _apply_eraser_stroke
from core.image_utils import make_transparent


def export_lines(*, mushaf_id: uuid.UUID, page_number: int) -> dict:
    """Render the page, crop each line to a transparent PNG, and store its path."""
    mushaf = mushaf_service.get_mushaf(mushaf_id)
    page = Page.objects.filter(mushaf=mushaf, page_number=page_number).first()
    if page is None:
        raise HttpError(404, "Page has no data to export.")

    pdf_index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page_number, page.source_pdf_page)
    image = Image.open(io.BytesIO(pdf.render_page(mushaf.pdf_file.path, pdf_index)))
    image.load()

    exported: list[dict] = []
    for line in page.lines.order_by("line_number").prefetch_related("erase_strokes"):
        png_bytes = _render_line_png(image, line)
        filename = f"{mushaf.id}_p{page_number:04d}_l{line.line_number:02d}.png"
        if line.line_png:
            line.line_png.delete(save=False)
        line.line_png.save(filename, ContentFile(png_bytes), save=True)
        exported.append({"line_number": line.line_number, "line_png": line.line_png.url})

    return {"page_number": page_number, "exported": len(exported), "lines": exported}


def _render_line_png(image: Image.Image, line: Line) -> bytes:
    left = max(0, line.bbox_x)
    top = max(0, line.bbox_y)
    right = min(image.width, line.bbox_x + line.bbox_w)
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

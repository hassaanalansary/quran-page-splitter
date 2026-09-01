"""Turn a mushaf's stored pages into the line images the boundary engine measures.

The engine takes pictures, not paths, which is what lets this exist at all: a line
can come off disk as an exported PNG or be cut fresh out of a rendered PDF page,
and the engine cannot tell the difference.

Three jobs:

* **Locate.** The caller names a start and end as ``(sura, aya)``. The process
  phase already recorded which line each aya sits on, so the pages need not be
  named — the span is found.
* **Crop.** An aya rarely begins exactly where a line does. Rather than shifting
  the request to the nearest clean line, the first line is cut at the boundary the
  separator detection already found, so the engine still receives a line that
  starts on a known first word. The last line is cut the same way at the far end.
* **Hand over what is already known.** The separators were located once during
  processing; their positions come along so the engine can skip finding them again.

Requires the **process phase** to have run — it is what puts lines, their
classification and the aya segmentation in the database. Finalize is optional: it
trims line height, which mostly means fewer strays reaching in from the lines above
and below, so it helps the engine without being a prerequisite.
"""

import io

from PIL import Image

from api.models import Line, LineTypeChoices, Mushaf, Page, Segment
from api.services import coordinates, pdf
from api.services.export import render_line_image
from core.word_boundary import LineImage


def separator_template(mushaf: Mushaf) -> Image.Image | None:
    """The mushaf's aya ornament, or None when it has no template saved."""
    template = mushaf.templates.filter(type="aya_separator").first()
    if template is None or not template.image:
        return None
    with template.image.open("rb") as handle:
        image = Image.open(io.BytesIO(handle.read()))
        image.load()
    return image


def locate(mushaf: Mushaf, sura: int, aya: int, *, last: bool = False) -> Segment:
    """The segment where an aya starts on the page — or ends, with ``last``.

    Reads the numbering the process phase wrote and ``renumber_mushaf`` keeps
    true. A run whose renumber has not happened yet holds nulls here and will not
    be found, which is the intended failure: better than locating the wrong line.
    """
    order: tuple[str, ...] = ("line__page__page_number", "line__line_number", "segment_order")
    if last:
        order = tuple("-" + field for field in order)
    segment = (
        Segment.objects.filter(
            line__page__mushaf=mushaf,
            line__type=LineTypeChoices.TEXT,
            line__sura_id=sura,
            aya_number=aya,
        )
        .select_related("line__page")
        .order_by(*order)
        .first()
    )
    if segment is None:
        raise LookupError(f"{sura}:{aya} is not on any text line of {mushaf.name}")
    return segment


def line_images(
    mushaf: Mushaf,
    *,
    start: tuple[int, int],
    end: tuple[int, int],
    refresh: bool = False,
) -> list[LineImage]:
    """Every text line from the start aya through the end aya, in reading order.

    Sura headers and besmella lines are left out: they are not text, and the
    engine has never accepted them.
    """
    first_segment = locate(mushaf, *start)
    last_segment = locate(mushaf, *end, last=True)
    first_line, last_line = first_segment.line, last_segment.line
    if _line_key(last_line) < _line_key(first_line):
        raise LookupError(f"{start[0]}:{start[1]}..{end[0]}:{end[1]} runs backwards through {mushaf.name}")

    pages = (
        Page.objects.filter(
            mushaf=mushaf,
            page_number__gte=first_line.page.page_number,
            page_number__lte=last_line.page.page_number,
        )
        .order_by("page_number")
        .prefetch_related("lines__segments", "lines__erase_strokes")
    )

    template = separator_template(mushaf)
    template_width = template.width if template is not None else 0
    out: list[LineImage] = []
    for page in pages:
        rendered_page: Image.Image | None = None
        column = coordinates.page_column(page)
        for line in sorted(page.lines.all(), key=lambda line: line.line_number):
            if line.type != LineTypeChoices.TEXT:
                continue
            if not (_line_key(first_line) <= _line_key(line) <= _line_key(last_line)):
                continue

            crop = _crop_for(line, first_line, last_line, first_segment, last_segment, column)
            if rendered_page is None and _needs_render(mushaf, line, crop, refresh):
                rendered_page = _render_page(mushaf, page)
            image, origin_x = _image_for(mushaf, line, page, column, rendered_page, crop, refresh)
            out.append(
                LineImage(
                    image=image,
                    label=f"page-{page.page_number:04d}/line-{line.line_number:02d}",
                    source=f"{mushaf.id}:{page.page_number}:{line.line_number}",
                    separators=_separators(line, origin_x, image.width, template_width),
                )
            )
    return out


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def _line_key(line: Line) -> tuple[int, int]:
    return (line.page.page_number, line.line_number)


def _origin_x(column: dict | None, line: Line) -> int:
    """Page x that image x 0 corresponds to, matching ``render_line_image``."""
    return max(0, column["x"] if column else line.bbox_x)


def _crop_for(
    line: Line,
    first_line: Line,
    last_line: Line,
    first_segment: Segment,
    last_segment: Segment,
    column: dict | None,
) -> tuple[int, int | None] | None:
    """Where to cut this line, in image x, or None to keep all of it.

    Arabic runs right to left, so a line's first word sits at its largest x. For
    the **start** aya, everything belonging to earlier ayat lies to the *right* of
    its first segment, so the cut keeps ``x`` up to that segment's right edge. For
    the **end** aya, later ayat lie to the *left* of its last segment, so the cut
    keeps ``x`` from that segment's left edge onward.
    """
    origin = _origin_x(column, line)
    left, right = 0, None
    if _line_key(line) == _line_key(last_line) and last_segment.segment_order > 1:
        left = max(0, last_segment.bbox_x - origin)
    if _line_key(line) == _line_key(first_line):
        segments = sorted(line.segments.all(), key=lambda s: s.segment_order)
        if segments and first_segment.segment_order > segments[0].segment_order:
            right = max(0, first_segment.bbox_x + first_segment.bbox_w - origin)
    if left == 0 and right is None:
        return None
    return (left, right)


def _needs_render(mushaf: Mushaf, line: Line, crop: tuple[int, int | None] | None, refresh: bool) -> bool:
    """A stored PNG will not do when page coordinates have to line up.

    ``export._pad_to`` *centres* each line on a page-sized canvas when
    ``export_uniform_size`` is on, so a stored PNG then carries a per-line offset
    that cannot be mapped back to page x — which breaks both the crop and the
    separator positions. Rendering puts image x 0 back on the column edge.
    """
    return refresh or crop is not None or mushaf.export_uniform_size or not line.line_png


def _render_page(mushaf: Mushaf, page: Page) -> Image.Image:
    index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page.page_number, page.source_pdf_page)
    image = Image.open(io.BytesIO(pdf.render_page(mushaf.pdf_file.path, index)))
    image.load()
    return image


def _image_for(
    mushaf: Mushaf,
    line: Line,
    page: Page,
    column: dict | None,
    rendered_page: Image.Image | None,
    crop: tuple[int, int | None] | None,
    refresh: bool,
) -> tuple[Image.Image, int]:
    """One line's picture, and the page x its left edge sits on."""
    origin = _origin_x(column, line)
    if _needs_render(mushaf, line, crop, refresh):
        assert rendered_page is not None
        image = render_line_image(rendered_page, line, column)
    else:
        with line.line_png.open("rb") as handle:
            image = Image.open(io.BytesIO(handle.read()))
            image.load()
    if crop is None:
        return image, origin
    left, right = crop
    right = image.width if right is None else min(right, image.width)
    left = min(left, right)
    return image.crop((left, 0, right, image.height)), origin + left


def _separators(line: Line, origin_x: int, width: int, template_width: int) -> list[tuple[int, int]] | None:
    """Ornament spans on this line, in the image's own coordinates.

    The process phase cuts each segment at the ornament's **left** edge, so that
    the ornament travels with the aya it terminates — which means a
    ``has_separator`` segment's ``bbox_x`` already *is* the ornament's left edge.
    The right edge was never stored because there is nothing to store: the matcher
    returns ``(x, x + template_width)`` and the pipeline drops the second half as
    redundant. It is rebuilt here from the template.

    ``None`` — meaning "find them yourself" — when there is no template to give a
    width, so the engine falls back to its own detectors.
    """
    if not template_width:
        return None
    spans: list[tuple[int, int]] = []
    for segment in sorted(line.segments.all(), key=lambda s: s.segment_order):
        if not segment.has_separator:
            continue
        left = segment.bbox_x - origin_x
        right = left + template_width
        # An ornament cut away by the crop is simply not on this image any more.
        if right > 0 and left < width:
            spans.append((max(0, left), min(width, right)))
    return spans

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
* **Remember where each picture sits.** The engine answers in the image's own
  coordinates; the database speaks page coordinates. ``PlacedLine`` carries the
  offset between them, because nothing downstream can work it out — see below.

Requires the **process phase** to have run — it is what puts lines, their
classification and the aya segmentation in the database. Finalize is optional: it
trims line height, which mostly means fewer strays reaching in from the lines above
and below, so it helps the engine without being a prerequisite.
"""

import io
from dataclasses import dataclass

from PIL import Image

from api.models import Line, LineTypeChoices, Mushaf, Page, Segment
from api.services import pdf
from api.services.export import render_line_image
from core.word_boundary import LineImage


@dataclass(frozen=True)
class PlacedLine:
    """One line's picture, and where on the page that picture sits.

    ``origin_x`` is the page x that image x 0 corresponds to. It is **not** derivable
    from ``line`` alone: a line's image starts at that line's own left edge, and the
    first and last line of a span are then cut again at an aya boundary, which moves
    the zero further right. That shift depends on which line is first and last *in
    this run*, so it is a property of the run rather than of the row — a writer
    holding only a ``Line`` cannot know whether its image was cropped, or by how much.

    So it travels with the picture. ``LineImage`` stays what the engine sees, knowing
    nothing about pages or rows; this is the caller's own bookkeeping, on the
    caller's side of that boundary.
    """

    image: LineImage
    line: Line
    origin_x: int


def separator_template(mushaf: Mushaf) -> Image.Image | None:
    """The mushaf's aya ornament, or None when it has no template saved."""
    template = mushaf.templates.filter(type="aya_separator").first()
    if template is None or not template.image:
        return None
    with template.image.open("rb") as handle:
        image = Image.open(io.BytesIO(handle.read()))
        image.load()
    return image


#: Template types that are neither text nor an aya end — printed among the words
#: and meaning nothing to the reading order. Named here rather than inlined at the
#: call site so adding a third is one entry.
SYMBOL_TEMPLATE_TYPES = ("sajda", "rub_hizb")


def symbol_templates(mushaf: Mushaf) -> dict[str, Image.Image]:
    """The mushaf's non-word symbols, by type, for the ones it has saved.

    Unlike the aya ornament these are *not* supplied as spans: the process phase
    located ornaments and stored them on each segment, and never looked for these.
    So the engine is handed the pictures and matches them itself — see
    ``core.word_boundary.separators.split_symbols``.

    Missing ones are simply absent from the map. A mushaf with neither still runs;
    it just reads the ink of any sajda or rub' it prints as though it were letters,
    which is what ``word_runs.preflight`` warns about.
    """
    found: dict[str, Image.Image] = {}
    for template in mushaf.templates.filter(type__in=SYMBOL_TEMPLATE_TYPES):
        with template.image.open("rb") as handle:
            image = Image.open(io.BytesIO(handle.read()))
            image.load()
        found[template.type] = image
    return found


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
) -> list[PlacedLine]:
    """Every text line from the start aya through the end aya, in reading order.

    Sura headers and besmella lines are left out: they are not text, and the
    engine has never accepted them.

    Every line is cut fresh from the PDF — see ``_image_for`` for why an exported
    PNG cannot stand in. There used to be a ``refresh`` flag to force that; it is
    now what always happens, so the flag went rather than lie about being optional.
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
    out: list[PlacedLine] = []
    for page in pages:
        rendered_page: Image.Image | None = None
        for line in sorted(page.lines.all(), key=lambda line: line.line_number):
            if line.type != LineTypeChoices.TEXT:
                continue
            if not (_line_key(first_line) <= _line_key(line) <= _line_key(last_line)):
                continue

            crop = _crop_for(line, first_line, last_line, first_segment, last_segment)
            if rendered_page is None:
                rendered_page = _render_page(mushaf, page)
            image, origin_x = _image_for(line, rendered_page, crop)
            out.append(
                PlacedLine(
                    image=LineImage(
                        image=image,
                        label=f"page-{page.page_number:04d}/line-{line.line_number:02d}",
                        source=f"{mushaf.id}:{page.page_number}:{line.line_number}",
                        separators=_separators(line, origin_x, image.width, template_width),
                    ),
                    line=line,
                    origin_x=origin_x,
                )
            )
    return out


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def _line_key(line: Line) -> tuple[int, int]:
    return (line.page.page_number, line.line_number)


def _origin_x(line: Line) -> int:
    """Page x that image x 0 corresponds to, matching ``render_line_image``.

    The **line's own** left edge, not the page column's. A column is as wide as the
    widest thing on the page — a sura header, and on a framed page the frame itself —
    so cutting every line there hands the engine ink that belongs to no word. It reads
    a printed border as letters, and because that ink touches image x 0 the tight crop
    can never trim it: al-Fatiha's lines came back with every word placed outside the
    line it was on. ``Line.bbox_x/bbox_w`` track the line's actual content, so they
    are the honest crop.
    """
    return max(0, line.bbox_x)


def _crop_for(
    line: Line,
    first_line: Line,
    last_line: Line,
    first_segment: Segment,
    last_segment: Segment,
) -> tuple[int, int | None] | None:
    """Where to cut this line, in image x, or None to keep all of it.

    Arabic runs right to left, so a line's first word sits at its largest x. For
    the **start** aya, everything belonging to earlier ayat lies to the *right* of
    its first segment, so the cut keeps ``x`` up to that segment's right edge. For
    the **end** aya, later ayat lie to the *left* of its last segment, so the cut
    keeps ``x`` from that segment's left edge onward.

    Each end is cut only when there is something there to remove, and the two tests
    are mirror images: the start aya must not be the line's **rightmost** segment
    (nothing lies right of it), the end aya must not be its **leftmost** (nothing
    lies left of it). Without that, an end aya sitting in the rightmost segment of
    its final line would keep every later aya on that line, and the engine would be
    handed ink for words it was never given.
    """
    origin = _origin_x(line)
    segments = sorted(line.segments.all(), key=lambda s: s.segment_order)
    left, right = 0, None
    if _line_key(line) == _line_key(last_line) and segments and last_segment.segment_order < segments[-1].segment_order:
        left = max(0, last_segment.bbox_x - origin)
    if (
        _line_key(line) == _line_key(first_line)
        and segments
        and first_segment.segment_order > segments[0].segment_order
    ):
        right = max(0, first_segment.bbox_x + first_segment.bbox_w - origin)
    if left == 0 and right is None:
        return None
    return (left, right)


def _render_page(mushaf: Mushaf, page: Page) -> Image.Image:
    index = pdf.logical_to_pdf_index(mushaf.first_quran_pdf_page, page.page_number, page.source_pdf_page)
    image = Image.open(io.BytesIO(pdf.render_page(mushaf.pdf_file.path, index)))
    image.load()
    return image


def _image_for(
    line: Line,
    rendered_page: Image.Image,
    crop: tuple[int, int | None] | None,
) -> tuple[Image.Image, int]:
    """One line's picture, and the page x its left edge sits on.

    **Always cut fresh**, never read back from ``line.line_png``. An exported PNG is
    cut at the page column and may have been centred on a page-sized canvas
    (``export._pad_to``, when ``export_uniform_size`` is on); either way its image x 0
    is not this line's left edge, so reusing one would quietly undo the crop that
    ``_origin_x`` explains. Rendering costs one page per page, not one per line — the
    caller renders once and passes it in.
    """
    origin = _origin_x(line)
    # column=None: cut at the line's own box. The export path passes a real column and
    # keeps its uniform width; only the engine wants the tight cut.
    image = render_line_image(rendered_page, line, None)
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

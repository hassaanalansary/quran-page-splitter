"""Photograph the page engine mid-thought — one PNG per step, in order.

Once, at the first breakpoint::

    import builtins, script.page_trace as T; builtins.T = T; T.start("page-161")

and then, at that stop and at every stop after it, the only command there is::

    T.stage(locals())

``builtins`` is what makes ``T`` survive the jump: a debug console evaluates inside
the frame you are paused in, so a name bound at one breakpoint is gone at the next.
``stage`` reads the frame it is handed, recognises which step of the engine holds
those names, and shoots the pictures for it.

Every call writes ``NN-label.png`` into one session directory and bumps NN, so the
files sort into the order the engine actually visited them and no two names collide.
``index.txt`` beside them records what each one was.

A camera, not a second engine. Everything here draws arrays and boxes that the frame
you are stopped in already holds; it derives nothing of its own. That is the whole
reason to take the picture from inside the frame instead of re-running the step
outside it — a reconstruction can agree with the engine and still be a different
calculation, and then the picture is evidence of nothing.

Where to stand
--------------

These values live only inside these frames. Stop there and shoot.

    pipeline.run                after ``create_context``    ctx.image, ctx.grey,
                                                            ctx.binary
    LineDetector.detect         after ``ctx.crop_box = ``   the crop, grey and binary
    SuraHeaderLocator.locate    before ``return selected``  the score map, the template
                                                            and the bands that won
    LineDetector._detect_with_sura_headers
                                after ``ctx.text_regions``  what is left for the lines
    split_by_valleys            at ``return boxes``         clean_binary, row_sums,
                                                            smoothed, minima,
                                                            prominences, valleys, boxes
    AyaSeparatorProcessor.split_segments
                                after ``_create_segments``  separator hits and the
                                                            segments cut from them
    PageProcessor.process       before ``# Stage 4``        ctx.lines, their segments,
                                                            and the tracker's numbers

The last two fire once per line and once per region; the third does not fire at all
on a page with no sura header. That is the engine telling you about the page.

Coordinates
-----------

Four spaces, and mixing them is the only way to get a wrong picture out of this: the
**page** (ctx.image, ctx.lines, every segment), the **crop** (everything
``LineDetector`` hands downward — headers, text regions), the **region** (one slice of
the crop, which is what ``split_by_valleys`` sees), and the **line** (where the aya
matcher reports its hits). Pass the base picture from the same frame as the boxes and
they agree by construction. ``context()`` is the only function here that knows an
offset, because it is the only one drawing all four at once.

Not for production. Nothing in ``core`` imports this, and nothing should.
"""

from __future__ import annotations

import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Run as a script, sys.path[0] is script/, not backend/, so the sibling ``core``
# package is invisible. Imported from a debug console under manage.py it is already
# there and this is a no-op.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

RED = (220, 30, 30)
GREEN = (0, 140, 60)
BLUE = (60, 110, 220)
AMBER = (230, 150, 0)
VIOLET = (150, 70, 200)
GREY = (150, 150, 150)

PALETTE = (GREEN, VIOLET, AMBER, BLUE, RED)
NAMED = {"red": RED, "green": GREEN, "blue": BLUE, "amber": AMBER, "violet": VIOLET, "grey": GREY}

#: A sibling of wl-out/ — scratch, gitignored, outside the app's media.
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "page-trace"

_dir: Path | None = None
_step = 0


# ----------------------------------------------------------------------
# Session
# ----------------------------------------------------------------------


def start(name: str = "page", out: str | Path | None = None) -> Path:
    """Open a session: everything from here lands in ``<out>/<name>/``.

    Called again with the same name it picks the numbering up where the directory
    left off, because a debugger that drops you back into the same frame twice
    should not quietly start a second set of files claiming to be the first steps.
    """
    global _dir, _step
    root = Path(out) if out is not None else DEFAULT_OUT
    _dir = root / name
    _dir.mkdir(parents=True, exist_ok=True)
    _step = max((_leading_number(path.name) for path in _dir.glob("*.png")), default=0)
    return _dir


def note(text: str) -> None:
    """Write a line into index.txt without spending a step number."""
    _index(f"    {text}")


def _leading_number(name: str) -> int:
    head = name.split("-", 1)[0]
    return int(head) if head.isdigit() else 0


def _session() -> Path:
    if _dir is None:
        start()
    assert _dir is not None
    return _dir


def _reserve(label: str) -> tuple[int, Path]:
    global _step
    _step += 1
    return _step, _session() / f"{_step:02d}-{label}.png"


def _index(line: str) -> None:
    with (_session() / "index.txt").open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def _write(canvas: Image.Image, label: str, what: str = "") -> Path:
    step, path = _reserve(label)
    canvas.save(path)
    _index(f"{step:02d}  {path.name}  {canvas.width}x{canvas.height}  {what}".rstrip())
    return path


# ----------------------------------------------------------------------
# Pictures in, an RGB canvas out
# ----------------------------------------------------------------------


def _canvas(picture: Any, invert: bool = False) -> Image.Image:
    """Any of this engine's picture shapes → an RGB canvas that can be drawn on.

    A 2-D uint8 array is taken exactly as it is stored, which for a *binary* array
    means ink 255 on background 0 — white text on black, what the engine actually
    holds. ``invert=True`` turns it back into something that prints.
    """
    if isinstance(picture, Image.Image):
        if picture.mode in ("RGBA", "LA", "P"):
            rgba = picture.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.split()[3])
            return flat
        return picture.convert("RGB")

    array = np.ascontiguousarray(picture)
    if array.dtype == bool:
        array = array.astype(np.uint8) * 255
    if array.dtype != np.uint8:
        top = float(array.max()) or 1.0
        array = np.clip(array / top * 255.0, 0, 255).astype(np.uint8)
    if invert:
        array = 255 - array
    return Image.fromarray(array).convert("RGB")


# ----------------------------------------------------------------------
# Boxes in, (left, top, right, bottom) out
# ----------------------------------------------------------------------


def _rect(item: Any, width: int) -> tuple[int, int, int, int]:
    """Normalise every box shape this engine passes around.

    Understands a BBox and anything carrying one (LineResult, SegmentResult), the
    left/top/right/bottom dicts ``split_by_valleys`` returns, the x/y/w/h dicts the
    coordinate exporter writes, a bare (x, y, w, h) tuple as ``find_content_bbox``
    returns it, and anything with only a top and a bottom — a sura header, a text
    region, a pair of split positions — which is drawn full width.
    """
    if hasattr(item, "bbox"):
        item = item.bbox
    if hasattr(item, "left") and hasattr(item, "right"):
        return int(item.left), int(item.top), int(item.right), int(item.bottom)
    if isinstance(item, dict):
        if "right" in item:
            return int(item["left"]), int(item["top"]), int(item["right"]), int(item["bottom"])
        if "w" in item:
            return int(item["x"]), int(item["y"]), int(item["x"]) + int(item["w"]), int(item["y"]) + int(item["h"])
        return 0, int(item["top"]), width, int(item["bottom"])
    if hasattr(item, "top") and hasattr(item, "bottom"):
        return 0, int(item.top), width, int(item.bottom)
    values = tuple(int(value) for value in item)
    if len(values) == 2:
        return 0, values[0], width, values[1]
    x, y, w, h = values
    return x, y, x + w, y + h


def _rects(items: Iterable[Any], width: int, offset: tuple[int, int] = (0, 0)) -> list[tuple[int, int, int, int]]:
    dx, dy = offset
    boxes = []
    for item in items:
        left, top, right, bottom = _rect(item, width)
        boxes.append((left + dx, top + dy, right + dx, bottom + dy))
    return boxes


def _layer(layer: Any, position: int) -> tuple[Sequence[Any], tuple[int, int, int]]:
    """Split a layer argument into its boxes and its colour.

    A colour is a name or an RGB triple, and only those: a 2-tuple whose second half
    is a 4-tuple is two boxes, not boxes and a colour.
    """
    items, colour = layer, PALETTE[position % len(PALETTE)]
    if isinstance(layer, tuple) and len(layer) == 2:
        candidate = layer[1]
        if isinstance(candidate, str) or (isinstance(candidate, tuple) and len(candidate) == 3):
            items, colour = layer
    if isinstance(colour, str):
        colour = NAMED[colour]
    return list(items), colour


def _font(px: int) -> Any:
    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


# ----------------------------------------------------------------------
# The camera
# ----------------------------------------------------------------------


def save(picture: Any, label: str, *, invert: bool = False) -> Path:
    """One picture, straight to disk. The plain step."""
    return _write(_canvas(picture, invert), label)


def overlay(picture: Any, label: str, *layers: Any, numbered: bool = True, invert: bool = False) -> Path:
    """Draw boxes over a picture — one layer per argument, each in its own colour.

    A layer is an iterable of boxes, or ``(boxes, colour)`` where colour is a name
    from NAMED or an RGB tuple. Without one, layers take PALETTE in order: the first
    is green, the second violet, and so on.

        T.overlay(binary, "bands", boxes)
        T.overlay(ctx.grey, "page", [ln.bbox for ln in ctx.lines], ([ctx.crop_box], "blue"))
    """
    canvas = _canvas(picture, invert)
    draw = ImageDraw.Draw(canvas)
    pen = max(2, round(canvas.height / 500))
    font = _font(max(14, round(canvas.height / 60)))
    drawn = 0

    for position, layer in enumerate(layers):
        items, colour = _layer(layer, position)
        drawn += len(items)
        for index, (left, top, right, bottom) in enumerate(_rects(items, canvas.width), start=1):
            draw.rectangle((left, top, right - 1, bottom - 1), outline=colour, width=pen)
            if numbered:
                draw.text((left + pen + 2, top + pen), str(index), fill=colour, font=font)

    return _write(canvas, label, f"{drawn} box(es)")


def pieces(picture: Any, boxes: Iterable[Any], label: str, *, invert: bool = False) -> list[Path]:
    """Cut each box out and save it — the strips themselves, not a drawing of them.

    They share one step number and differ by a suffix, because they are one step.
    """
    canvas = _canvas(picture, invert)
    step, _ = _reserve(label)
    paths: list[Path] = []
    for index, (left, top, right, bottom) in enumerate(_rects(boxes, canvas.width), start=1):
        path = _session() / f"{step:02d}-{label}-{index:02d}.png"
        canvas.crop((left, top, right, bottom)).save(path)
        paths.append(path)
    _index(f"{step:02d}  {label}-NN.png  {len(paths)} piece(s)")
    return paths


def cuts(picture: Any, label: str, *layers: Any, numbered: bool = True, invert: bool = False) -> Path:
    """Vertical marks down a line strip — where the ornaments are, and where it cuts.

    The separator matcher answers in *columns*: ``locate_x_matches`` returns
    ``(x, x + template_width)`` pairs, and ``_create_segments`` then cuts at the left
    edge of each. A pair here is drawn as a band and a bare number as a full-height
    line, which is the difference between showing what was found and showing what was
    done about it:

        T.cuts(line_gray, "separators", boxes)
        T.cuts(line_gray, "cut-lines", ([left for left, _ in boxes], "red"))

    Do not hand those pairs to ``overlay`` — it reads a 2-tuple as a top and a bottom
    and would draw a confident picture of the wrong axis.
    """
    canvas = _canvas(picture, invert)
    draw = ImageDraw.Draw(canvas)
    pen = max(2, round(canvas.height / 60))
    font = _font(max(12, round(canvas.height / 8)))
    drawn = 0

    for position, layer in enumerate(layers):
        items, colour = _layer(layer, position)
        drawn += len(items)
        for index, item in enumerate(items, start=1):
            if isinstance(item, int | np.integer | float):
                x = int(item)
                draw.line((x, 0, x, canvas.height), fill=colour, width=pen)
            else:
                left, right = (int(value) for value in item)
                draw.rectangle((left, 0, right - 1, canvas.height - 1), outline=colour, width=pen)
                x = left
            if numbered:
                draw.text((x + pen + 2, 2), str(index), fill=colour, font=font)

    return _write(canvas, label, f"{drawn} mark(s)")


def profile(
    values: Any,
    label: str,
    *,
    under: Any = None,
    minima: Iterable[int] = (),
    prominences: Iterable[float] = (),
    valleys: Iterable[int] = (),
    beside: Any = None,
    invert: bool = False,
    width: int | None = None,
) -> Path:
    """The row-sum signal as a chart, drawn down the page so rows line up with ink.

    Row 0 is at the top and the bars grow rightwards, which is what lets ``beside``
    paste the very strip the signal was measured from against it: a trough and the
    gap between two printed lines then sit on the same pixel row, and the picture
    argues for itself.

    ``under`` draws a second, paler signal behind this one — the raw sums beneath the
    smoothed ones. ``minima`` ticks every candidate, scaled by ``prominences`` when
    those are given, and ``valleys`` draws the chosen ones right across the picture.

    ``invert`` is for the strip alone: a binary array carries ink at 255, so it comes
    out as white text on black unless it is turned over.
    """
    signal = np.asarray(values, dtype=np.float64).ravel()
    rows = signal.size
    chart_w = int(width or max(240, min(640, rows // 3)))
    peak = float(np.nanmax(signal)) if rows else 0.0
    if under is not None:
        peak = max(peak, float(np.nanmax(np.asarray(under, dtype=np.float64))))
    peak = peak or 1.0

    canvas = np.full((rows, chart_w, 3), 255, np.uint8)

    def draw_signal(data: Any, fill: tuple[int, int, int], stroke: tuple[int, int, int]) -> None:
        scaled = np.asarray(data, dtype=np.float64).ravel() / peak * (chart_w - 1)
        lengths = np.clip(scaled, 0, chart_w - 1).astype(np.int64)
        canvas[np.arange(chart_w)[None, :] <= lengths[:, None]] = fill
        canvas[np.arange(rows), lengths] = stroke

    if under is not None:
        draw_signal(under, _pale(GREY, 0.75), GREY)
    draw_signal(signal, _pale(BLUE, 0.80), BLUE)

    chart = Image.fromarray(canvas)
    chart_x = 0
    if beside is not None:
        strip = _canvas(beside, invert)
        if strip.height != rows:
            raise ValueError(
                f"beside has {strip.height} rows and the signal has {rows} — they come "
                "from different arrays, so nothing in the picture would line up"
            )
        composed = Image.new("RGB", (strip.width + chart.width, rows), (255, 255, 255))
        composed.paste(strip, (0, 0))
        composed.paste(chart, (strip.width, 0))
        chart_x = strip.width
        chart = composed

    draw = ImageDraw.Draw(chart)
    tick = max(8, chart_w // 20)
    scores = list(prominences)
    best = max(scores) if scores else 0.0
    for index, row in enumerate(minima):
        length = tick
        if best and index < len(scores):
            length = max(3, round(scores[index] / best * tick * 3))
        draw.line((chart_x, int(row), chart_x + length, int(row)), fill=AMBER, width=1)
    for row in valleys:
        draw.line((0, int(row), chart.width, int(row)), fill=RED, width=max(1, rows // 900))

    return _write(chart, label, f"{rows} rows, peak {peak:.0f}")


def _pale(colour: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    red, green, blue = (round(channel + (255 - channel) * amount) for channel in colour)
    return red, green, blue


def heat(match: Any, label: str, *, mark_best: bool = True) -> Path:
    """A template-match score map as a picture — bright is a good match.

    The map is smaller than the picture it was matched against by the template's own
    size minus one, and its (0, 0) is where the template's top-left corner sat. Read
    a position off it as the *top-left* of a hit, never its centre.
    """
    import cv2

    scores = np.asarray(match, dtype=np.float64)
    low, high = float(scores.min()), float(scores.max())
    spread = (high - low) or 1.0
    eight_bit = np.clip((scores - low) / spread * 255.0, 0, 255).astype(np.uint8)
    coloured = cv2.applyColorMap(eight_bit, cv2.COLORMAP_INFERNO)[:, :, ::-1]
    canvas = Image.fromarray(np.ascontiguousarray(coloured))

    if mark_best and scores.size:
        y, x = (int(position) for position in np.unravel_index(int(np.argmax(scores)), scores.shape))
        draw = ImageDraw.Draw(canvas)
        radius = max(4, canvas.height // 60)
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(255, 255, 255), width=2)
        draw.text((x + radius + 3, y), f"{high:.4f}", fill=(255, 255, 255), font=_font(max(12, radius * 2)))

    return _write(canvas, label, f"scores {low:.4f}..{high:.4f}")


def stage(ns: dict) -> str:
    """Shoot whichever step of the engine the paused frame is holding.

        (Pdb) T.stage(locals())

    The one command, at every stop. It recognises a step by the names in front of it,
    which is why the tests below are ordered from the most specific frame outward:
    ``split_by_valleys`` has a ``boxes`` too, so it has to be asked about before the
    separator step is. Sura headers are drawn top-down, which is the order the very
    next line of ``locate`` puts them in.

    A frame it does not recognise is not an error — it says so and lists what it saw,
    and the individual functions are still there for anything this does not cover.
    """

    def holds(*names: str) -> bool:
        return all(name in ns for name in names)

    written: list[Path] = []

    if holds("row_sums", "smoothed", "clean_binary", "boxes"):
        clean, raw, smooth = ns["clean_binary"], ns["row_sums"], ns["smoothed"]
        peaks, scores = ns["minima"], ns["prominences"]
        written += [
            save(clean, "tight-to-content", invert=True),
            profile(raw, "row-sums", beside=clean, invert=True),
            profile(smooth, "smoothed", under=raw, beside=clean, invert=True),
            profile(smooth, "minima", minima=peaks, prominences=scores, beside=clean, invert=True),
            profile(
                smooth,
                "valleys",
                minima=peaks,
                prominences=scores,
                valleys=ns["valleys"],
                beside=clean,
                invert=True,
            ),
            overlay(ns["binary"], "bands", ns["boxes"], invert=True),
        ]
        written += pieces(ns["grey"], ns["boxes"], "band")

    elif holds("line", "line_gray", "boxes"):
        line = ns["line"]
        tag = f"line{line.line_index:02d}"
        hits = ns["boxes"]
        written.append(cuts(ns["line_gray"], f"{tag}-separators", hits, ([left for left, _ in hits], "red")))
        if line.segments and "ctx" in ns:
            written += pieces(ns["ctx"].image, line.segments, f"{tag}-segment")

    elif holds("match", "spec", "gray"):
        written += [save(ns["spec"].image, "sura-template"), heat(ns["match"], "sura-scores")]
        if ns.get("selected"):
            bands = sorted(ns["selected"], key=lambda header: header.top)
            written.append(overlay(ns["gray"], "sura-bands", (bands, "red")))

    elif holds("regions", "headers", "binary"):
        written.append(
            overlay(ns["binary"], "text-regions", (ns["regions"], "violet"), (ns["headers"], "red"), invert=True)
        )

    elif holds("ctx", "cropped_grey", "cropped_binary"):
        written += [
            overlay(ns["ctx"].grey, "crop-box", ([ns["ctx"].crop_box], "blue")),
            save(ns["cropped_binary"], "cropped-binary", invert=True),
        ]

    elif holds("ctx"):
        ctx = ns["ctx"]
        if ctx.lines:
            written.append(context(ctx, "everything"))
        else:
            written += [save(ctx.image, "page"), save(ctx.grey, "grey"), save(ctx.binary, "binary", invert=True)]

    else:
        seen = ", ".join(sorted(name for name in ns if not name.startswith("_")))
        return f"no step recognised in this frame. It holds: {seen}"

    return f"{_session()} <- " + ", ".join(path.name for path in written)


def context(ctx: Any, label: str = "page") -> Path:
    """Everything the page knows so far, on one picture.

    The one function here that does arithmetic on coordinates: a PageContext stores
    its headers and text regions crop-relative, and this shifts them into page space
    so they can be drawn beside the lines, which are not.
    """
    canvas = _canvas(ctx.image)
    draw = ImageDraw.Draw(canvas)
    pen = max(2, round(canvas.height / 500))
    font = _font(max(14, round(canvas.height / 60)))
    crop = ctx.crop_box
    offset = (crop.left, crop.top) if crop is not None else (0, 0)
    crop_w = crop.width if crop is not None else canvas.width

    if crop is not None:
        draw.rectangle((crop.left, crop.top, crop.right - 1, crop.bottom - 1), outline=BLUE, width=pen)
    for left, top, right, bottom in _rects(ctx.text_regions, crop_w, offset):
        draw.rectangle((left, top, right - 1, bottom - 1), outline=VIOLET, width=pen)
    for left, top, right, bottom in _rects(ctx.detected_headers, crop_w, offset):
        draw.rectangle((left, top, right - 1, bottom - 1), outline=RED, width=pen)
    for line in ctx.lines:
        box = line.bbox
        draw.rectangle((box.left, box.top, box.right - 1, box.bottom - 1), outline=GREEN, width=pen)
        draw.text((box.left + pen + 2, box.top + pen), str(line.line_index), fill=GREEN, font=font)
        for segment in line.segments:
            seg = segment.bbox
            draw.rectangle(
                (seg.left + pen, seg.top + pen, seg.right - pen - 1, seg.bottom - pen - 1),
                outline=AMBER,
                width=pen,
            )

    return _write(canvas, label, f"{len(ctx.lines)} line(s)")

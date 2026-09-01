"""Command line for the word-boundary engine — the prototype's front door.

Give it an aya span and the line images that cover it, in order. It writes a copy
of each line with a vertical red line at the end of every word.

    uv run python script/word_lines.py --out ../wl-out \
        --quran "../data/quran-uthmani.txt" \
        --from 7:82 --to 7:87 \
        media/mushafs/<id>/lines/page-0161/line-*.png

Images must end up in reading order. Wildcards are expanded by the script and
sorted, which is reading order for zero-padded line-NN.png names — so the same
command works in PowerShell, where the shell does not glob for native programs.
Pass --lines FILE instead to read the ordered paths from a file.

Sura headers and besmella lines are not text lines — leave them out.

What is here, and what is not
-----------------------------

The engine is not here. It lives in ``core.word_boundary`` and returns **data**:
where every component of ink sits, what it was read as, and where each word ends.
This file is two adapters either side of one call to it.

*In*: ``images_from_paths`` for the pictures and ``words_from_ayat`` for the word
stream, assembled into a ``WordBoundaryInput``. The other adapter reads the
database instead — see ``api.services.word_inputs`` — and the engine cannot tell
which one it was handed.

*Out*: ``render`` draws the boxes and cuts, ``report`` prints the table, and
``as_dict`` serialises it. All three read the result and nothing else. Where the
``--cut`` choice lands is decided here on purpose: the engine says where a word
ends, and drawing that as an edge or as a midpoint is a rendering opinion.

For how the alignment actually works, read ``core.word_boundary`` — the package
docstring first, then ``alignment.py``.
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Run as a script, sys.path[0] is script/, not backend/, so the sibling ``core``
# package is invisible. Django and the test runner start from backend/ and do not
# need this; running ``python script/word_lines.py`` does.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.quran_text import Aya, load_ayat, span
from core.word_boundary import (
    InkComponent,
    LineImage,
    WordBoundaryInput,
    WordLine,
    detect_words,
    images_from_paths,
    words_from_ayat,
)

_POINT_RE = re.compile(r"^\s*(\d+)\s*(?::\s*(\d+))?\s*$")


def parse_point(value: str, *, default_sura: int | None = None) -> tuple[int, int]:
    """Parse 'S:A', or bare 'A' when a sura is already established."""
    match = _POINT_RE.match(value)
    if not match:
        raise SystemExit(f"bad aya reference {value!r}; expected S:A (e.g. 2:16) or a bare aya number.")
    if match[2] is not None:
        return int(match[1]), int(match[2])
    if default_sura is None:
        raise SystemExit(f"{value!r} needs a sura: write it as S:A, e.g. 2:{match[1]}.")
    return default_sura, int(match[1])


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

RED = (220, 30, 30)
GREEN = (0, 140, 60)
GREY = (200, 170, 170)
BLUE = (60, 110, 220)
AMBER = (230, 150, 0)


def render(
    line: LineImage,
    result: WordLine,
    destination: Path,
    *,
    mode: str,
    labels: bool,
    debug: bool,
) -> None:
    """Draw one line's result onto its own image and save it.

    Every coordinate on ``result`` is already in this image's space, so nothing
    here does arithmetic on positions — it reads them.
    """
    im = line.image
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[3])
    else:
        canvas = im.convert("RGB")

    draw = ImageDraw.Draw(canvas)
    width = max(2, round(canvas.height / 60))

    if debug:
        for component in result.components:
            if component.role == "mark":
                _outline(draw, component, GREY, 1)
        for component in result.components:
            if component.role == "body":
                _outline(draw, component, GREEN, 2)
        for component in result.components:
            if component.role == "ornament":
                _outline(draw, component, AMBER, 3)
        # A tie is drawn *inside* the role box, never over it. Blue says the two
        # cheapest readings disagreed about this component; the green or grey box
        # it sits in says which of them was committed.
        for component in result.components:
            if component.ambiguous and component.role != "ornament":
                _outline(draw, component, BLUE, 2, inset=3)
        if result.status in {"unresolved", "partial"}:
            draw.text((4, 2), f"{result.status.upper()}: {result.reason}", fill=BLUE)
        for y in result.band:
            draw.line([0, y, canvas.width, y], fill=BLUE, width=1)

    if result.status == "unresolved":
        destination.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(destination)
        return

    for ornament in result.ornaments:
        for x in (ornament.right, ornament.left):
            draw.line([x, 0, x, canvas.height], fill=AMBER, width=width)

    words = result.words
    for i, box in enumerate(words):
        if mode == "midpoint" and i + 1 < len(words) and words[i + 1].right < box.end_x:
            x = round((box.end_x + words[i + 1].right) / 2)
        else:
            x = box.end_x
        draw.line([x, 0, x, canvas.height], fill=RED, width=width)
        if labels:
            draw.text((x + 4, 2), str(i + 1), fill=RED)

    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination)


def _outline(
    draw: ImageDraw.ImageDraw,
    component: InkComponent,
    colour: tuple[int, int, int],
    width: int,
    inset: int = 0,
) -> None:
    draw.rectangle(
        [
            component.x + inset,
            component.y + inset,
            component.right - inset,
            component.bottom - inset,
        ],
        outline=colour,
        width=width,
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def report(ayat: list[Aya], lines: list[WordLine]) -> bool:
    total_cuts = sum(len(line.ornaments) for line in lines)
    print(f"span {ayat[0].key} .. {ayat[-1].key}   {len(ayat)} ayat, {sum(len(a.words) for a in ayat)} words")
    print(f"lines {len(lines)}   separators found {total_cuts}   sequential PAW parser")

    print()
    print(f"{'line':<22}{'words':>6}{'paws':>6}{'bodies':>8}{'sep':>5}{'cost':>6}{'off':>5}  result")
    print("-" * 82)
    ok = True
    for line in lines:
        mine = [box for box in line.words if box.components]
        wanted = sum(box.expected_paws for box in mine)
        got = sum(len(box.components) for box in mine)
        if line.status == "unresolved":
            state = f"UNRESOLVED: {line.reason} ({line.end_sequences} end sequences)"
            ok = False
        elif line.status == "scored":
            state = f"scored: {line.reason}"
        elif line.status == "partial":
            # Ornaments split a line into independent segments; some resolved and
            # some did not, and the resolved ones keep their boundaries.
            stretches = [s for s in line.segments if s.status != "empty"]
            done = sum(1 for s in stretches if s.resolved)
            state = f"PARTIAL {done}/{len(stretches)} segments: {line.reason}"
            ok = False
        else:
            state = line.status
        cost = "-" if line.cost is None else str(line.cost)
        print(
            f"{line.label:<22}{len(mine):>6}{wanted:>6}{got:>8}"
            f"{len(line.ornaments):>5}{cost:>6}{line.deviations:>5}  {state}"
        )
    print("-" * 82)
    per_line = [sum(1 for box in line.words if box.components) for line in lines]
    print(f"words per line (derived): {per_line}")
    unresolved = sum(line.status == "unresolved" for line in lines)
    if unresolved:
        print(f"unresolved lines: {unresolved} — no word-end lines drawn for them")
    return ok


def as_dict(ayat: list[Aya], lines: list[WordLine]) -> dict:
    return {
        "span": {"from": ayat[0].key, "to": ayat[-1].key, "ayat": len(ayat)},
        "method": "sequential-paw",
        "separators_found": sum(len(line.ornaments) for line in lines),
        "lines": [
            {
                "index": i,
                "image": line.source,
                "separators": len(line.ornaments),
                "status": line.status,
                "unresolved_reason": line.reason,
                "minimum_flips": line.cost,
                "end_sequences": line.end_sequences,
                "segments": [
                    {
                        "status": s.status,
                        "reason": s.reason,
                        "words": s.words,
                        "end_sequences": s.end_sequences,
                        "deviations": s.deviations,
                    }
                    for s in line.segments
                ],
                "component_roles": {
                    "bodies": sum(c.role == "body" for c in line.components),
                    "marks": sum(c.role == "mark" for c in line.components),
                    "role_ambiguous": sum(c.ambiguous for c in line.components),
                },
                "words": [
                    {
                        "word": box.text,
                        "aya": box.aya,
                        "expected_paws": box.expected_paws,
                        "blobs": len(box.components),
                        "merged": box.merged,
                        "bbox": {"x": box.x, "y": box.y, "w": box.w, "h": box.h},
                        "end_x": box.end_x,
                    }
                    for box in line.words
                ],
            }
            for i, line in enumerate(lines)
        ],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="word_lines",
        description="Draw a vertical red line at the end of every word across a span of ayat.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("images", nargs="*", type=Path, help="Line images, in reading order.")
    parser.add_argument("--out", help="Directory for the annotated copies; not needed with --no-render.")
    parser.add_argument("--quran", required=True, type=Path, help="Tanzil 'sura|aya|text' file.")
    parser.add_argument("--from", dest="start", required=True, help="First aya, e.g. 7:82.")
    parser.add_argument("--to", dest="end", required=True, help="Last aya, e.g. 7:87 (or bare 87).")
    parser.add_argument("--lines", type=Path, help="File of ordered image paths, one per line.")
    parser.add_argument("--separator-template", type=Path, help="Aya separator template PNG.")
    parser.add_argument(
        "--separator-threshold",
        type=float,
        default=0.35,
        help="Template match score above which a hit counts (default: %(default)s).",
    )
    parser.add_argument(
        "--cut",
        choices=("edge", "midpoint"),
        default="edge",
        help="Put the line on the word's own left edge, or midway to the next (default: %(default)s).",
    )
    parser.add_argument("--no-labels", action="store_true", help="Do not number the cuts.")
    parser.add_argument("--debug", action="store_true", help="Also draw bodies, marks and the ornaments.")
    parser.add_argument(
        "--no-render",
        action="store_true",
        help="Report only, drawing nothing — for batch checks over many pages.",
    )
    parser.add_argument("--keep-basmala", action="store_true", help="Do not strip Tanzil's prepended basmala.")
    parser.add_argument("--json", type=Path, help="Write a machine-readable report here.")
    return parser


_WILDCARDS = ("*", "?", "[")


def _expand(pattern: str, root: Path | None = None) -> list[Path]:
    """Resolve one argument to real files, expanding wildcards ourselves.

    PowerShell and cmd do not glob for native programs — the pattern arrives
    verbatim — so a command that works under bash would otherwise fail on
    Windows with a filename containing a literal '*'. Matches are sorted, which
    is reading order for the pipeline's zero-padded line-NN.png names.
    """
    candidates = [pattern]
    if root is not None and not Path(pattern).is_absolute():
        candidates.append(str(root / pattern))

    if any(ch in pattern for ch in _WILDCARDS):
        for candidate in candidates:
            if matches := sorted(glob.glob(candidate)):
                return [Path(m) for m in matches]
        raise SystemExit(f"no images match {pattern!r}")

    for candidate in candidates:
        if Path(candidate).exists():
            return [Path(candidate)]
    raise SystemExit(f"missing image: {pattern}")


def collect_images(args: argparse.Namespace) -> list[Path]:
    paths: list[Path] = []
    for image in args.images:
        paths += _expand(str(image))
    if args.lines:
        root = args.lines.parent
        for raw in args.lines.read_text(encoding="utf-8").splitlines():
            name = raw.strip()
            if name and not name.startswith("#"):
                paths += _expand(name, root)
    if not paths:
        raise SystemExit("no images given: pass them as arguments or with --lines.")
    return paths


def _open_template(path: Path) -> Image.Image:
    """The ornament as a picture — preparing it is the engine's business."""
    with Image.open(path) as handle:
        handle.load()
        return handle.copy()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.no_render and not args.out:
        raise SystemExit("--out is required unless --no-render is given.")

    start = parse_point(args.start)
    end = parse_point(args.end, default_sura=start[0])
    try:
        ayat = span(load_ayat(args.quran, strip_basmala=not args.keep_basmala), start, end)
    except (LookupError, ValueError) as error:
        raise SystemExit(str(error)) from error

    # Everything the engine needs, assembled here and handed over. Files are one
    # source of it; quran.services.words + api.services.line_images are another.
    paths = collect_images(args)
    template = _open_template(args.separator_template) if args.separator_template is not None else None
    source = WordBoundaryInput(
        lines=images_from_paths(paths),
        words=words_from_ayat(ayat),
        separator_template=template,
    )

    try:
        result = detect_words(source, separator_threshold=args.separator_threshold)
    except ValueError as error:
        raise SystemExit(str(error)) from error

    if not args.no_render:
        out = Path(args.out)
        # Every page directory holds a line-01.png, so a run spanning pages would
        # write all of them to the same name and keep only the last. The page
        # directory joins the name only when it has to, so a single-page run
        # still writes the plain line-NN-words.png it always did.
        stems = [path.stem for path in paths]
        names = stems if len(set(stems)) == len(stems) else [f"{p.parent.name}-{p.stem}" for p in paths]
        for i, (line, outcome) in enumerate(zip(source.lines, result.lines, strict=True)):
            render(
                line,
                outcome,
                out / f"{names[i]}-words.png",
                mode=args.cut,
                labels=not args.no_labels,
                debug=args.debug,
            )

    ok = report(ayat, result.lines)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        payload = as_dict(ayat, result.lines)
        args.json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"report -> {args.json}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

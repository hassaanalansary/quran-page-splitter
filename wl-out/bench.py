"""Accuracy bench for the word-boundary engine, across mushafs.

    cd backend
    PYTHONPATH=. uv run python ../wl-out/bench.py list
    PYTHONPATH=. uv run python ../wl-out/bench.py take <mushaf> --tag <slug> --spans 7:1-7:60 ...

``list`` answers "what can actually be run?" - every mushaf, its riwaya, its i'jam
mode, which templates it has captured, how many pages are processed and reviewed, and
which suras it holds with the aya range available in each. Picking a span without this
is guessing.

``take`` runs the engine exactly as a job would (``prepare_engine_input`` -> supplied
separators from the reviewed segments -> ``detect_words``) over each span and writes,
under ``wl-out/bench/<tag>/``:

    <span>.json        every line's status, reason, cost, ornaments and placed words
    lines/<p>_<l>.png  one debug render per line, full resolution
    pages/p<n>.png     a contact sheet - a page's lines stacked, each captioned
    sheet.md           per line: status, reason, and the ordered word list
    summary.md         status counts and a histogram of reasons

Nothing is written to the database. ``take`` is read-only on the DB and cuts its
lines fresh from the PDF, so it can be re-run at will.

Sibling of snapshot.py, which does before/after on one pinned mushaf; this one ranges
over several and produces something gradable by eye.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from collections import Counter
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.db.models import Count, Max, Min  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from api.models import LineTypeChoices, Mushaf, Page, Segment  # noqa: E402
from api.services import word_inputs, word_runs  # noqa: E402
from core.word_boundary import detect_words  # noqa: E402
from script.word_lines import render  # noqa: E402

OUT = Path(__file__).resolve().parent / "bench"


# -- mushaf lookup -------------------------------------------------------------
def resolve(token: str) -> Mushaf:
    """A mushaf by id, by id prefix, or by a case-insensitive part of its name."""
    try:
        return Mushaf.objects.get(pk=uuid.UUID(token))
    except (ValueError, Mushaf.DoesNotExist):
        pass
    matches = list(Mushaf.objects.filter(name__icontains=token))
    if not matches:
        matches = [m for m in Mushaf.objects.all() if str(m.id).startswith(token)]
    if not matches:
        raise SystemExit(f"no mushaf matches {token!r} - run `bench.py list`.")
    if len(matches) > 1:
        names = "\n  ".join(f"{m.id}  {m.name}" for m in matches)
        raise SystemExit(f"{token!r} matches {len(matches)} mushafs:\n  {names}")
    return matches[0]


# -- list ----------------------------------------------------------------------
def listing() -> None:
    for mushaf in Mushaf.objects.all().order_by("name"):
        pages = Page.objects.filter(mushaf=mushaf)
        total = pages.count()
        reviewed = pages.filter(reviewed=True).count()
        templates = sorted(mushaf.templates.values_list("type", flat=True))
        rawi = getattr(mushaf.rawi, "name", None) or "- not set -"
        span = word_runs.available_span(mushaf)
        span_text = f"{span[0][0]}:{span[0][1]} .. {span[1][0]}:{span[1][1]}" if span else "- nothing renumbered -"

        print(f"\n{'=' * 78}")
        print(f"{mushaf.name}")
        print(f"  id         {mushaf.id}")
        print(f"  riwaya     {rawi}          visibility {mushaf.visibility}")
        print(f"  ijam_mode  {mushaf.ijam_mode}")
        print(f"  templates  {', '.join(templates) or '- none -'}")
        print(f"  pages      {total} processed, {reviewed} reviewed   (pdf has {mushaf.pdf_page_count})")
        print(f"  span       {span_text}")

        rows = (
            Segment.objects.filter(
                line__page__mushaf=mushaf,
                line__type=LineTypeChoices.TEXT,
                aya_number__isnull=False,
                line__sura__isnull=False,
            )
            .values("line__sura_id", "line__sura__transliteration")
            .annotate(
                lo=Min("aya_number"),
                hi=Max("aya_number"),
                p_lo=Min("line__page__page_number"),
                p_hi=Max("line__page__page_number"),
                pages=Count("line__page_id", distinct=True),
            )
            .order_by("line__sura_id")
        )
        if rows:
            print(f"  {'sura':>4}  {'name':<22} {'ayat held':<14} {'pages':<12} n")
            for row in rows:
                ayat = f"{row['lo']}-{row['hi']}"
                pages_text = f"{row['p_lo']}-{row['p_hi']}"
                name = row["line__sura__transliteration"] or ""
                print(f"  {row['line__sura_id']:>4}  {name:<22} {ayat:<14} {pages_text:<12} {row['pages']}")


# -- take ----------------------------------------------------------------------
def parse_span(text: str) -> tuple[tuple[int, int], tuple[int, int]]:
    left, right = text.split("-")
    s1, a1 = (int(n) for n in left.split(":"))
    s2, a2 = (int(n) for n in right.split(":"))
    return (s1, a1), (s2, a2)


def span_name(text: str) -> str:
    return text.replace(":", "_")


def _font(size: int):
    for name in ("arial.ttf", "seguisb.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _draw(image, outcome, path: Path) -> Image.Image | None:
    """Render with the debug overlay; without it where the CLI cannot.

    ``_outline`` insets a box by 3px and PIL refuses the rectangle on a component
    under 6px tall. The cuts are what gets judged, so the line is drawn without its
    overlay rather than dropped.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        render(image, outcome, path, mode="end", labels=True, debug=True)
    except ValueError:
        render(image, outcome, path, mode="end", labels=True, debug=False)
    try:
        return Image.open(path).convert("RGB")
    except OSError:
        return None


def contact_sheet(strips: list[tuple[str, Image.Image]], path: Path) -> None:
    """One page's lines stacked in reading order, each under its own caption.

    Lines are pasted right-aligned because the script is RTL and the right margin is
    the one that lines up; a left-aligned stack makes every short line look shifted.
    """
    if not strips:
        return
    width = max(im.width for _, im in strips)
    cap_h = max(16, min(34, max(im.height for _, im in strips) // 4))
    font = _font(max(11, cap_h - 8))
    gap = 8
    height = sum(im.height + cap_h + gap for _, im in strips) + gap
    sheet = Image.new("RGB", (width, height), (245, 245, 245))
    draw = ImageDraw.Draw(sheet)
    y = gap
    for caption, im in strips:
        draw.text((4, y + 2), caption, fill=(20, 20, 20), font=font)
        y += cap_h
        sheet.paste(im, (width - im.width, y))
        y += im.height + gap
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


ROLE_INK = {"body": (0, 140, 60), "mark": (150, 90, 90), "ornament": (230, 150, 0), "symbol": (60, 110, 220)}


def blob_sheet(image: Image.Image, components: list[dict], path: Path) -> None:
    """The rendered line with every blob's id printed beneath it.

    So a reviewer can say "blob 23 should be a body" instead of describing where on
    the line it sits. Ids alternate between two rows because a dense line puts them
    closer together than a two-digit number is wide. Colour repeats the role already
    drawn on the blob's box, so the strip alone says what the engine decided.
    """
    row = 17
    canvas = Image.new("RGB", (image.width, image.height + row * 2 + 4), (255, 255, 255))
    canvas.paste(image, (0, 0))
    draw = ImageDraw.Draw(canvas)
    font = _font(13)
    for index, component in enumerate(sorted(components, key=lambda c: -(c["x"] + c["w"] / 2))):
        centre = component["x"] + component["w"] / 2
        label = str(component["id"])
        width = draw.textlength(label, font=font)
        y = image.height + 2 + (row if index % 2 else 0)
        draw.text((max(0, min(canvas.width - width, centre - width / 2)), y),
                  label, fill=ROLE_INK.get(component["role"], (20, 20, 20)), font=font)
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path)


def take(mushaf: Mushaf, tag: str, spans: list[str]) -> None:
    root = OUT / tag
    root.mkdir(parents=True, exist_ok=True)
    held = ", ".join(sorted(mushaf.templates.values_list("type", flat=True))) or "none"
    sheet_md: list[str] = [
        f"# {tag} - {mushaf.name}",
        "",
        f"riwaya: {getattr(mushaf.rawi, 'name', None)}  ",
        f"ijam_mode: `{mushaf.ijam_mode}`  ",
        f"templates: {held}",
        "",
    ]
    statuses: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    grand_lines = grand_words = 0

    for text in spans:
        start, end = parse_span(text)
        prepared = word_inputs.prepare_engine_input(mushaf.id, user=mushaf.owner, start=start, end=end)
        result = detect_words(prepared.source)
        lines: list[dict] = []
        by_page: dict[int, list[tuple[str, Image.Image]]] = {}
        sheet_md += [f"## span {text}", ""]

        for outcome, placed in zip(result.lines, prepared.placements, strict=True):
            page, line_no = placed.line.page.page_number, placed.line.line_number
            lines.append(
                {
                    "label": outcome.label,
                    "source": outcome.source,
                    "page": page,
                    "line": line_no,
                    "origin_x": placed.origin_x,
                    "status": outcome.status,
                    "reason": outcome.reason,
                    "deviations": outcome.deviations,
                    "ties": outcome.end_sequences,
                    "cost": outcome.cost,
                    "ornaments": [[o.left, o.right] for o in outcome.ornaments],
                    "band": list(outcome.band),
                    # Every blob the line was read as, with the role the engine settled
                    # on and the evidence it had. This is the decision under review: a
                    # body/mark call is what fixes the word boundaries, since each word
                    # then takes exactly the blob count its spelling requires.
                    "components": [
                        {
                            "id": c.id,
                            "x": c.x,
                            "y": c.y,
                            "w": c.w,
                            "h": c.h,
                            "role": c.role,
                            "ambiguous": c.ambiguous,
                            "body_score": c.body_score,
                        }
                        for c in outcome.components
                    ],
                    "words": [
                        {
                            "word_id": w.word_id,
                            "text": w.text,
                            "aya": w.aya,
                            "end_x": w.end_x + placed.origin_x,
                            "image_end_x": w.end_x,
                            "components": len(w.components),
                            "component_ids": list(w.components),
                            "expected_paws": w.expected_paws,
                            "right": w.right,
                        }
                        for w in outcome.words
                    ],
                }
            )
            statuses[outcome.status] += 1
            for part in (outcome.reason or "").split("; "):
                if part:
                    reasons[part] += 1
            grand_words += len(outcome.words)

            image = _draw(placed.image, outcome, root / "lines" / f"p{page:03d}_l{line_no:02d}.png")
            if image is not None:
                blob_sheet(image, lines[-1]["components"], root / "blobs" / f"p{page:03d}_l{line_no:02d}.png")
            caption = f"p{page}:l{line_no}  {outcome.status}  {len(outcome.words)}w"
            if outcome.reason:
                caption += f"  [{outcome.reason}]"
            if image is not None:
                by_page.setdefault(page, []).append((caption, image))

            words = "  ".join(f"{i + 1}.{word.text}" for i, word in enumerate(outcome.words))
            sheet_md += [
                f"**p{page}:l{line_no}** - `{outcome.status}`"
                + (f" - {outcome.reason}" if outcome.reason else "")
                + f" - dev {outcome.deviations}, ties {outcome.end_sequences}, "
                f"cost {outcome.cost}, {len(outcome.ornaments)} ornament(s)",
                "",
                words or "_(no words placed)_",
                "",
            ]

        for page, strips in sorted(by_page.items()):
            contact_sheet(strips, root / "pages" / f"p{page:03d}.png")

        grand_lines += len(lines)
        payload = {
            "mushaf": {"id": str(mushaf.id), "name": mushaf.name, "ijam_mode": mushaf.ijam_mode},
            "span": text,
            "complete": result.complete,
            "words_consumed": result.words_consumed,
            "words_total": len(prepared.source.words),
            "lines": lines,
        }
        (root / f"{span_name(text)}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), "utf-8")
        counts = Counter(line["status"] for line in lines)
        print(
            f"{tag:>14}  {text:<14} {len(lines):>4} lines  "
            f"{sum(len(line['words']) for line in lines):>5} words  "
            f"consumed {result.words_consumed}/{len(prepared.source.words)}  {dict(counts)}"
        )

    (root / "sheet.md").write_text("\n".join(sheet_md), "utf-8")
    summary = [
        f"# {tag} - {mushaf.name}",
        "",
        f"- riwaya: {getattr(mushaf.rawi, 'name', None)}",
        f"- ijam_mode: `{mushaf.ijam_mode}`",
        f"- templates: {held}",
        f"- spans: {', '.join(spans)}",
        f"- {grand_lines} lines, {grand_words} placed words",
        "",
        "## status",
        "",
        *(f"- `{k}` {v}  ({v / max(1, grand_lines):.1%})" for k, v in statuses.most_common()),
        "",
        "## reasons",
        "",
        *(f"- {k} - {v}" for k, v in reasons.most_common()),
        "",
    ]
    (root / "summary.md").write_text("\n".join(summary), "utf-8")
    print("\n".join(summary[7:]))
    print(f"written to {root}")


# -- cli -----------------------------------------------------------------------
def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="every mushaf and what it actually holds")
    p_take = sub.add_parser("take", help="run the engine over spans and write gradable output")
    p_take.add_argument("mushaf", help="id, id prefix, or part of the name")
    p_take.add_argument("--tag", required=True, help="output folder under wl-out/bench/")
    p_take.add_argument("--spans", nargs="+", required=True, help="S:A-S:A ...")
    args = parser.parse_args(argv)

    if args.command == "list":
        listing()
    else:
        take(resolve(args.mushaf), args.tag, args.spans)


if __name__ == "__main__":
    main(sys.argv[1:])

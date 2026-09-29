"""Enumerate the cheapest readings of one aya and draw every one of them.

    cd backend
    PYTHONPATH=. uv run python ../wl-out/paths.py b9975701 2:1-2:30 2:17 --top 100

The engine commits one reading and reports a cost. That tells you nothing about
*why* it won — whether the correct reading was dearer, or was never a candidate at
all. This keeps the best ``--top`` readings of a single aya instead of merging them
away, prints them ranked with their costs, and draws one image each.

The DP is the engine's own, with one change: ``states[key]`` holds a *list* of
records rather than the single best, truncated to ``--top`` after every blob. So
these are genuinely the k cheapest complete readings of that aya, not a sample.

Colour says what the reading did with each blob, against what its evidence
suggested:

    green   body,  and it looked like one        agreed
    grey    mark,  and it looked like one        agreed
    RED     body,  but it looked like a mark     PROMOTED — a mark read as a letter
    BLUE    mark,  but it looked like a body     DEMOTED  — a letter thrown away
    amber   ornament        purple  sajda / rub' symbol

Each blob carries its id; each word boundary is a black line labelled with the
word's position in the aya. The caption gives the rank, the cost, and the split of
that cost between blob evidence and COUNT_WEIGHT penalties.

Nothing is written to the database.
"""

from __future__ import annotations

import argparse
import json
import sys
from bisect import insort
from dataclasses import asdict, dataclass, replace
from heapq import merge
from itertools import islice
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from core.word_boundary.alignment import (
    ParseRecord,
    StateKey,
    _state_key,
    _with_body,
    _with_mark,
)
from core.word_boundary.calibration import COUNT_SLACK, COUNT_WEIGHT
from core.word_boundary.ink import LineInk, analyse_line
from core.word_boundary.inputs import aya_starts
from core.word_boundary.separators import prepare_template, split_separators, split_symbols
from core.word_boundary.span import _Commit, _events, parse_span

OUT = Path(__file__).resolve().parent / "paths"

AGREED_BODY = (0, 140, 60)
AGREED_MARK = (185, 160, 160)
PROMOTED = (220, 30, 30)
DEMOTED = (60, 110, 220)
ORNAMENT = (230, 150, 0)
SYMBOL = (150, 60, 200)


def _font(size: int):
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


@dataclass
class Reading:
    """One complete parse of the aya."""

    cost: int
    deviations: int
    groups: tuple[tuple[int, ...], ...]
    ends: tuple[int, ...]
    inversions: int = 0
    paw_errors: int = 0

    @classmethod
    def from_record(cls, record: ParseRecord) -> Reading:
        return cls(record.cost, record.deviations, record.groups, record.ends, record.inversions, record.paw_errors)

    @property
    def blob_cost(self) -> int:
        return self.cost - COUNT_WEIGHT * self.paw_errors


def _order(record: ParseRecord):
    return record.rank, record.groups, record.current_group


def _keep_best(bucket: list[ParseRecord], candidate: ParseRecord, top: int) -> None:
    """Insert, keep sorted by rank, truncate. The one change from the engine's DP."""
    insort(bucket, candidate, key=_order)
    del bucket[top:]


def stretch_for(trace: list[_Commit], start_word: int, end_word: int) -> _Commit:
    """Use the production search's actual anchors, including recovery resets."""
    matches = [c for c in trace if c.start_word == start_word and c.next_word == end_word]
    if len(matches) != 1:
        raise ValueError("aya is not one engine commit; an anchor may be missing or the search budget was reached")
    return matches[0]


def _suffix_bounds(events, words, start_word: int, end_word: int, top: int):
    """Exact kth total cost and cheapest suffixes, ignoring only geometry ties.

    Geometry changes neither allowed moves nor evidence costs. This compact
    backward search gives an admissible bound for the geometry-aware search.
    Repeated costs represent distinct paths and must not be deduplicated.
    """
    keys = [(w, done) for w in range(start_word, end_word) for done in range(words[w].paws + COUNT_SLACK)] + [
        (end_word, 0)
    ]
    suffixes = {(end_word, 0): [0]}
    bounds = [{} for _ in range(len(events) + 1)]
    bounds[-1] = {(end_word, 0): 0}
    empty = ParseRecord(0, (), (), (), 0)
    for index in range(len(events) - 1, -1, -1):
        event = events[index]
        if event.kind == "line-end":
            suffixes = {key: costs for key, costs in suffixes.items() if key[1] == 0}
        elif event.kind == "blob":
            previous = {}
            for key in keys:
                moves = [(key, event.blob.cost_as_mark)]
                moves.extend(
                    (produced_key[:2], r.cost) for produced_key, r in _with_body(empty, event.blob, 0, words, key)
                )
                streams = [
                    [cost + tail for tail in suffixes[next_key]] for next_key, cost in moves if next_key in suffixes
                ]
                if streams:
                    previous[key] = list(islice(merge(*streams), top))
            suffixes = previous
        else:
            raise ValueError("an aya window must not contain an intermediate ornament")
        bounds[index] = {key: costs[0] for key, costs in suffixes.items()}
    totals = suffixes.get((start_word, 0), [])
    return (totals[-1] if totals else None), bounds


def enumerate_readings(events, words, start_word: int, end_word: int, top: int) -> list[Reading]:
    """The ``top`` cheapest readings that take words ``start_word``..``end_word``."""
    if top < 1:
        raise ValueError("top must be positive")
    words = words[:end_word]
    ceiling, bounds = _suffix_bounds(events, words, start_word, end_word, top)
    if ceiling is None:
        return []
    states: dict[StateKey, list[ParseRecord]] = {(start_word, 0, None, None): [ParseRecord(0, (), (), (), 0)]}
    for index, event in enumerate(events):
        if event.kind == "line-end":
            kept: dict[StateKey, list[ParseRecord]] = {}
            for key, bucket in states.items():
                if key[1] == 0:
                    for record in bucket:
                        candidate = replace(record, previous_end=None, current_left=None)
                        _keep_best(kept.setdefault(_state_key(key[0], 0, candidate), []), candidate, top)
            states = kept
            continue
        if event.kind != "blob":
            raise ValueError("an aya window must not contain an intermediate ornament")
        assert event.blob is not None
        nxt: dict[StateKey, list[ParseRecord]] = {}

        def keep(key, candidate, remaining_costs=bounds[index + 1], target=nxt):
            remaining = remaining_costs.get(key[:2])
            if remaining is not None and candidate.cost + remaining <= ceiling:
                _keep_best(target.setdefault(key, []), candidate, top)

        for key, bucket in states.items():
            for record in bucket:
                keep(key, _with_mark(record, event.blob))
                for produced_key, produced in _with_body(record, event.blob, event.ident, words, key):
                    keep(produced_key, produced)
        states = nxt

    finals = sorted((r for key, bucket in states.items() if key[:2] == (end_word, 0) for r in bucket), key=_order)
    return [Reading.from_record(r) for r in finals[:top]]


def role_counts(reading: Reading, by_ident, scoped: set[int]) -> tuple[int, int]:
    used = {i for group in reading.groups for i in group}
    promoted = sum(by_ident[i][1].preferred != "body" for i in used)
    demoted = sum(by_ident[i][1].preferred == "body" for i in scoped - used)
    return promoted, demoted


def draw(
    reading: Reading,
    rank: int,
    chosen: bool,
    inks,
    images,
    by_ident,
    words,
    start_word,
    path: Path,
    cheapest: int,
    scoped: set[int],
    where: dict[int, str] | None = None,
):
    """One image: every blob boxed by what this reading made of it."""
    used = {ident for group in reading.groups for ident in group}
    cap = 56
    strips = []
    for line_index, ink in inks:
        canvas = images[line_index].convert("RGB")
        art = ImageDraw.Draw(canvas)
        small = _font(12)
        for ident, (owner_line, blob) in by_ident.items():
            if owner_line != line_index or ident not in scoped:
                continue
            looked_body = blob.preferred == "body"
            is_body = ident in used
            colour = (
                (AGREED_BODY if looked_body else PROMOTED) if is_body else (DEMOTED if looked_body else AGREED_MARK)
            )
            width = 3 if colour in (PROMOTED, DEMOTED) else 2
            x, y = blob.x + ink.offset_x, blob.y + ink.offset_y
            art.rectangle([x, y, x + blob.w - 1, y + blob.h - 1], outline=colour, width=width)
            art.text((x + 1, max(0, y - 13)), str(blob.label), fill=colour, font=small)
        for span in ink.separator_spans:
            art.rectangle(
                [span[0] + ink.offset_x, 0, span[1] + ink.offset_x, canvas.height - 1], outline=ORNAMENT, width=3
            )
        for span in getattr(ink, "symbol_spans", []) or []:
            art.rectangle(
                [span[0] + ink.offset_x, 0, span[1] + ink.offset_x, canvas.height - 1], outline=SYMBOL, width=3
            )
        for offset, group in enumerate(reading.groups):
            if not group or by_ident[group[0]][0] != line_index:
                continue
            cut = min(by_ident[i][1].x for i in group) + ink.offset_x
            art.line([cut, 0, cut, canvas.height], fill=(20, 20, 20), width=2)
            art.text((cut + 3, 2), f"{offset + 1}.{words[start_word + offset].text}", fill=(20, 20, 20), font=small)
        strips.append(canvas)

    band = 18
    width = max(s.width for s in strips)
    sheet = Image.new("RGB", (width, sum(s.height for s in strips) + cap + (band + 8) * len(strips)), (255, 255, 255))
    head = ImageDraw.Draw(sheet)
    promoted, demoted = role_counts(reading, by_ident, scoped)
    label = (
        f"#{rank}{'  <- ENGINE CHOSEN' if chosen else ''}   TOTAL COST {reading.cost}"
        f"   ({reading.cost - cheapest:+d} vs cheapest {cheapest})"
        f"   = evidence {reading.blob_cost} + {reading.paw_errors} PAWs x {COUNT_WEIGHT}"
    )
    font_size = 18
    while head.textbbox((0, 0), label, font=_font(font_size))[2] > width - 12 and font_size > 8:
        font_size -= 1
    head.text((6, 6), label, fill=(20, 20, 20), font=_font(font_size))
    head.text(
        (6, 30),
        f"Off-count words {reading.deviations} | same-line inversions {reading.inversions}"
        f" | promoted {promoted}, demoted {demoted}",
        fill=(20, 20, 20),
        font=_font(16),
    )
    y = cap
    for (line_index, _), strip in zip(inks, strips, strict=True):
        head.text((6, y + 2), (where or {}).get(line_index, f"line {line_index}"), fill=(90, 90, 90), font=_font(13))
        y += band
        sheet.paste(strip, (width - strip.width, y))
        y += strip.height + 8
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def main() -> None:
    import os

    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    django.setup()
    from api.services import word_inputs

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bench import parse_span as parse_span_text
    from bench import resolve

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mushaf")
    ap.add_argument("span", help="the run's span, e.g. 2:1-2:30")
    ap.add_argument("aya", help="the aya to enumerate, e.g. 2:17")
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--out", type=Path, help="output directory; use a new directory to preserve earlier runs")
    args = ap.parse_args()
    if args.top < 1:
        ap.error("--top must be positive")

    mushaf = resolve(args.mushaf)
    start, end = parse_span_text(args.span)
    prepared = word_inputs.prepare_engine_input(mushaf.id, user=mushaf.owner, start=start, end=end)
    source = prepared.source
    words = source.words

    picked = [i for i, w in enumerate(words) if w.aya == args.aya]
    if not picked:
        raise SystemExit(f"{args.aya} is not in {args.span}")
    start_word, end_word = picked[0], picked[-1] + 1

    template = prepare_template(source.separator_template) if source.separator_template is not None else None
    symbols = {name: prepare_template(image, name) for name, image in source.symbol_templates.items()}
    inks: list[LineInk] = []
    for line in source.lines:
        ink = analyse_line(line)
        split_symbols(ink, symbols)
        split_separators(ink, template, match_threshold=0.35)
        inks.append(ink)

    events, by_ident = _events(inks)
    # Only the ink between the ornament that opens this aya and the one that closes
    # it can belong to it, so the enumeration runs over that stretch alone —
    # otherwise the aya's first word could reach back into an earlier line.
    trace: list[_Commit] = []
    parse_span(inks, words, aya_starts=aya_starts(words), ijam=source.ijam, trace=trace)
    try:
        commit = stretch_for(trace, start_word, end_word)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    begin, stop = commit.event_start, commit.event_stop
    assert commit.record is not None
    engine_reading = Reading.from_record(commit.record)
    window = events[begin:stop]
    scoped = {e.ident for e in window if e.kind == "blob"}
    lines_touched = sorted({e.line for e in window if e.kind == "blob"})
    pages = [
        f"p{prepared.placements[i].line.page.page_number}:l{prepared.placements[i].line.line_number}"
        for i in lines_touched
    ]
    print(f"stretch: {stop - begin} events over {', '.join(pages)}")
    readings = enumerate_readings(window, words, start_word, end_word, args.top)
    if not readings:
        raise SystemExit(
            f"no reading of {args.aya} finished on word {end_word}; "
            f"the aya's ink may not be bounded by its ornaments in this span"
        )

    print(
        f"{args.aya}: words {start_word}..{end_word - 1} ({end_word - start_word} words), "
        f"{len(readings)} reading(s) kept of --top {args.top}\n"
    )
    cheapest = readings[0].cost
    print(f"{'#':>4} {'cost':>6} {'Δ':>5} {'evid.':>6} {'off':>4} {'PAWs':>5} {'inv':>4} {'promoted':>9}  first words")
    out = args.out or OUT / f"{mushaf.id.hex[:8]}_{args.aya.replace(':', '_')}"
    used_lines = [(i, inks[i]) for i in lines_touched]
    images = {i: prepared.placements[i].image.image for i in lines_touched}
    where = {
        i: f"p{prepared.placements[i].line.page.page_number}:l{prepared.placements[i].line.line_number}"
        for i in lines_touched
    }
    for rank, reading in enumerate(readings, start=1):
        promoted = sum(1 for i in {i for g in reading.groups for i in g} if by_ident[i][1].preferred != "body")
        preview = "  ".join(
            f"{words[start_word + o].text}={[by_ident[i][1].label for i in g]}"
            for o, g in enumerate(reading.groups[:4])
        )
        chosen = reading.groups == engine_reading.groups
        print(
            f"{rank:>4} {reading.cost:>6} {reading.cost - cheapest:>+5} {reading.blob_cost:>6}"
            f" {reading.deviations:>4} {reading.paw_errors:>5} {reading.inversions:>4} {promoted:>9}"
            f"  {preview}{'  <- ENGINE CHOSEN' if chosen else ''}"
        )
        draw(
            reading,
            rank,
            chosen,
            used_lines,
            images,
            by_ident,
            words,
            start_word,
            out / f"{rank:03d}_cost{reading.cost}.png",
            cheapest,
            scoped,
            where,
        )
    chosen_ranks = [i for i, r in enumerate(readings, 1) if r.groups == engine_reading.groups]
    print(f"engine reading: {chosen_ranks or 'outside the retained complete readings'}")
    if not chosen_ranks:
        draw(
            engine_reading,
            0,
            True,
            used_lines,
            images,
            by_ident,
            words,
            start_word,
            out / "engine_chosen.png",
            cheapest,
            scoped,
            where,
        )
    report = {
        "aya": args.aya,
        "span": args.span,
        "top": args.top,
        "engine_ranks": chosen_ranks,
        "engine": asdict(engine_reading),
        "readings": [asdict(r) for r in readings],
        "components": {i: {"line": by_ident[i][0], "label": by_ident[i][1].label} for i in sorted(scoped)},
    }
    (out / "readings.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(readings)} image(s) written to {out}")


if __name__ == "__main__":
    main()

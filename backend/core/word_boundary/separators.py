"""Aya separators — the anchors that turn a line of ink into addressable ayat.

An ornament is the one thing on a line whose meaning is known before any word is
matched: it closes an aya. Pulling it out of the text ink turns it into an
explicit event, which is what lets ``alignment`` cut the blob sequence into
stretches and parse each on its own.

Two detectors, unioned, because they fail differently. The **template** needs to
be the right template for this mushaf; the **hole test** needs a clean ring, which
a broken or overlapped ornament may not give.

Neither runs when the caller already knows where the ornaments are —
``LineImage.separators`` carries them, the process phase having found them once
already. ``None`` means "find them yourself", which is what a bare directory of
PNGs always says. Both paths must keep working.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from core.imaging import find_content_bbox, match_template_ccoeff_normed
from core.word_boundary.ink import Blob, LineInk

logger = logging.getLogger(__name__)

#: A blob must enclose a hole at least this share of its own box to read as the
#: separator ring. Measured: real ornaments score 0.38, while the worst letter
#: false-positive on a calligraphic line scores 0.04 — a wide, safe margin.
#: Size and fill alone are NOT enough: a swept calligraphic letter can be square
#: and hollow-looking (aspect 1.01, fill 0.17) and would be dropped as a phantom
#: separator on a line that has none.
HOLE_FRACTION = 0.12

#: Score a symbol template must reach to be believed. Higher than the ornament's
#: 0.35 because the two fail in opposite directions: a missed ornament merely
#: leaves the engine to its shape detector, while a false symbol **deletes real
#: ink** from the line and no review step would ever show it. An ornament is also
#: routinely broken or overlapped, which is what forces its threshold down; a
#: sajda marker printed inline is not.
#:
#: A score alone is not enough, though. A small, nearly solid template matches any
#: round blob of its size: al-Shamarly's rub' star scores 0.50-0.53 on the head of a
#: و, and 0.72-0.85 on a real star. So a hit must also be a sign of its own
#: (:func:`find_pieces_of_sign`) before any ink leaves the text.
SYMBOL_MATCH_THRESHOLD = 0.5

#: How far past the template's box a sign's pieces may reach, as a share of the
#: template's width and height: a printed sign is seldom the template's exact size,
#: nor the match exactly on it.
SYMBOL_BOX_MARGIN = 0.2

#: The share of the ink inside a hit's box that must belong to the sign's own pieces.
#: A letter's head fails, its ink belonging to a letter that runs on outside the box;
#: the rest lets a neighbour's tail graze a real sign.
SYMBOL_OWN_INK = 0.9


def split_separators(
    ink: LineInk,
    template: np.ndarray | None,
    *,
    match_threshold: float = 0.35,
) -> None:
    """Partition ``ink.bodies`` into text bodies and ornaments, in place.

    Records where each ornament falls in the surviving body order, which is what
    turns it into a cut point once every line's bodies are concatenated.

    Skipped entirely when ``ink.supplied_separators`` is set; otherwise both
    detectors run and their hits are unioned. Since the template is trimmed
    to its ink (see ``prepare_template``) the two agree closely — on the test page each
    finds the same six ornaments, the template scoring 0.67+ on every one against
    0.15 for any line without one. They are kept together because they fail
    differently: the template needs to be the right template for this mushaf,
    while the hole test needs a clean ring that a broken or overlapped ornament
    may not give.
    """
    if ink.supplied_separators is not None:
        # The caller found these already — the process phase does exactly this work
        # and stores the result, so paying for it twice is waste. Its spans are in
        # image coordinates; everything below works in the tight crop.
        spans = merge_overlapping_spans(
            [(left - ink.offset_x, right - ink.offset_x) for left, right in ink.supplied_separators]
        )
        logger.info(
            "    ornaments: %d supplied by the caller, detectors skipped — %s",
            len(spans),
            describe_spans(spans, ink.offset_x) or "none",
        )
    else:
        by_template = find_spans_by_template(ink, template, match_threshold) if template is not None else []
        by_shape = find_spans_by_shape(ink)
        spans = merge_overlapping_spans([*by_template, *by_shape])
        logger.info(
            "    ornaments: template found %d, shape found %d, %d after merging — %s",
            len(by_template),
            len(by_shape),
            len(spans),
            describe_spans(spans, ink.offset_x) or "none",
        )
    if not spans:
        return

    # The ring and its digits share a span, so the parser sees one explicit
    # ornament event rather than several text components. Ink that reaches past the
    # ring — the last word's fatha over its shoulder — is the text's.
    ink.separator_spans = spans
    ink.separator_ayat = label_spans_with_ayat(ink, spans)
    kept, groups, befores = partition_ornament_pieces(ink.components, spans)
    ink.separators = groups
    ink.separator_after = befores
    ink.components = kept
    ink.bodies = [b for b in kept if b.preferred == "body"]
    ink.marks = [b for b in kept if b.preferred != "body"]
    for index, (pieces, after) in enumerate(zip(ink.separators, ink.separator_after, strict=True), start=1):
        logger.info(
            "      ornament %d/%d x=%d..%d, %d piece(s) %s, after %d body(ies) of this line",
            index,
            len(ink.separators),
            min(b.x for b in pieces) + ink.offset_x,
            max(b.right for b in pieces) + ink.offset_x,
            len(pieces),
            [b.label for b in pieces],
            after,
        )
    logger.info(
        "      text ink left: %d component(s), %d body / %d mark (was %d)",
        len(kept),
        len(ink.bodies),
        len(ink.marks),
        len(kept) + sum(len(pieces) for pieces in ink.separators),
    )


def describe_spans(spans: list[tuple[int, int]], offset_x: int) -> str:
    """Spans as the caller would name them: image coordinates, not the tight crop."""
    return " ".join(f"{left + offset_x}..{right + offset_x}" for left, right in spans)


def merge_overlapping_spans(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Collapse overlapping hits so one ornament cannot be counted twice."""
    if not spans:
        return []
    merged: list[tuple[int, int]] = []
    for left, right in sorted(spans):
        if merged and left <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], right))
        else:
            merged.append((left, right))
    # Right-to-left, to match the body order.
    return sorted(merged, key=lambda s: -s[1])


def partition_ornament_pieces(
    components: list[Blob],
    spans: list[tuple[int, int]],
) -> tuple[list[Blob], list[list[Blob]], list[int]]:
    """Split components into the text and one group of pieces per ornament span.

    Membership is by **centre**, not overlap: a letter whose tail reaches under an
    ornament still belongs to the text, and a dot sitting inside one does not.

    The span is the template's width, and can reach well past the ring it found —
    128 px against a 95 px ring on the first mushaf's opening pages. So a piece
    also has to start and end inside the ring's own x-range, the ring being the
    span's largest piece; the digits do, and a mark of the last word that reaches
    over the ring's shoulder or sits beside it does not, and stays text::

        span     ├──────────────────────────────┤
        ring       ╭──────────╮
        digit         [7]                         inside: the ornament's
        fatha                   ╲                 past the ring: the text's

    The third return is, for each group, how many text bodies precede it: that is
    what turns a span into a cut point once every line's bodies are concatenated.
    """
    rings: dict[tuple[int, int], Blob] = {}
    for blob in components:
        centre = blob.x + blob.w / 2
        span = next(((s[0], s[1]) for s in spans if s[0] <= centre <= s[1]), None)
        if span is not None and (span not in rings or blob.area > rings[span].area):
            rings[span] = blob
    kept: list[Blob] = []
    groups: list[list[Blob]] = []
    befores: list[int] = []
    current: tuple[int, int] | None = None
    bodies_before = 0
    for blob in components:
        centre = blob.x + blob.w / 2
        span = next((s for s in spans if s[0] <= centre <= s[1]), None)
        ring = rings.get((span[0], span[1])) if span is not None else None
        if ring is not None and blob is not ring and (blob.x < ring.x or blob.right > ring.right):
            # In the span but past the ring: ink of the text beside the ornament.
            # The group it interrupts goes on.
            kept.append(blob)
            if blob.preferred == "body":
                bodies_before += 1
            continue
        if span is None:
            kept.append(blob)
            if blob.preferred == "body":
                bodies_before += 1
            current = None
            continue
        if span != current:
            groups.append([])
            befores.append(bodies_before)
            current = span
        groups[-1].append(blob)
    return kept, groups, befores


def split_symbols(
    ink: LineInk,
    templates: Mapping[str, np.ndarray],
    *,
    match_threshold: float = SYMBOL_MATCH_THRESHOLD,
) -> None:
    """Take non-word symbols out of the ink — a sajda marker, a rub' rosette.

    **Like an ornament in one way and unlike it in every other.** The engine must
    not read either as letters. But an ornament also *closes an aya*: ``span.parse_span`` collapses its live readings
    at every entry in ``separator_spans`` and keeps only those finishing on an aya
    boundary. A sajda closes nothing. Push one through that path and it would not
    merely be skipped — it would end the aya there and skip every word the aya had
    left, which is worse than the misreading it was meant to fix.

    So this registers **no span** in ``separator_spans`` and emits no parser event.
    The blobs simply stop existing as far as the alignment is concerned, exactly as
    if the symbol had not been printed.

    **Run before ``split_separators``**, so the ornament pass counts only real text
    bodies when it records where each cut point falls — and so the shape detector's
    median body height is not skewed by a rosette.

    Detected here rather than supplied, because nothing upstream looked: the
    process phase locates aya ornaments and stores them, and knows nothing about
    these. That also means the aya path's supplied-spans short-circuit must not
    swallow this pass, which is why it is its own function and not a branch of
    ``split_separators``.

    **A hit is a box, not a column.** A score says only that something there looks
    like the template, and the round head of a letter can. So a hit counts only when
    the ink in its box is a sign of its own, and only that sign's pieces leave the
    text (:func:`find_pieces_of_sign`). The mark above a hit, and the letter whose
    head was matched, stay text::

                    ┌────┐
        fatha       │    │  /       above the box: text
        rub' star   │ ✸  │          wholly inside it: the symbol
                    └────┘
                    ┌────┐
        و           │ ●  │__        runs on outside the box: no symbol at all
                    └────┘
    """
    if not templates:
        return
    hits = [
        hit for name, template in templates.items() for hit in find_symbol_hits(ink, template, name, match_threshold)
    ]
    groups = claim_symbol_pieces(hits)
    if not groups:
        return
    taken = {blob.label for _, pieces in groups for blob in pieces}
    kept = [blob for blob in ink.components if blob.label not in taken]
    ink.symbols = groups
    ink.symbol_spans = [(min(b.x for b in pieces), max(b.right for b in pieces)) for _, pieces in groups]
    ink.components = kept
    ink.bodies = [b for b in kept if b.preferred == "body"]
    ink.marks = [b for b in kept if b.preferred != "body"]
    logger.info(
        "    symbols: %d removed from the text ink — %s",
        len(ink.symbols),
        ", ".join(
            f"{name} x={left + ink.offset_x}..{right + ink.offset_x} ({len(group)} blob(s))"
            for (name, group), (left, right) in zip(ink.symbols, ink.symbol_spans, strict=True)
        ),
    )


def prepare_template(im: Image.Image, name: str = "aya separator") -> np.ndarray:
    """A template as black ink on white, trimmed to its ink.

    Trimmed for the same reason the line is. The saved template carries white
    margin, and matchTemplate needs somewhere for that margin to sit; an ornament
    flush against the end of a line offers none, so the score collapses —
    measured 0.13-0.20 there against 0.70+ for the same ornament mid-line.
    Trimming also shrinks it enough to fit at all: this project's 128x122
    template is 120x111 once trimmed, and the shortest line on a page is 120.

    Deliberately NOT rescaled to fit. Rescaling wrecks the match, and every line
    is cut to span the page width with padding around its content, so a template
    that still does not fit is the wrong template rather than a size to correct.

    Prepared once per run by the caller, since the array is never mutated.
    """
    grey = np.array(im.convert("L"))
    _, binary = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    box = find_content_bbox(binary)
    if box is None:
        raise ValueError(f"the {name} template has no ink in it.")
    x, y, w, h = box
    logger.info(
        "%s template: %dx%d supplied, %dx%d after trimming to its ink", name.capitalize(), im.width, im.height, w, h
    )
    # Rendered the same way as the line below, so the correlation compares like
    # with like instead of a binary mask against a greyscale scan.
    return np.where(binary[y : y + h, x : x + w] > 0, np.uint8(0), np.uint8(255))


#: Set once the oversize warning has been printed, so it is not repeated per line.
OVERSIZE_WARNED = False


def score_template_columns(ink: LineInk, template: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """How well ``template`` matches with its left edge at each column of the line —
    the best of every row — and the row it matched best at. None when the template
    is larger than the line."""
    global OVERSIZE_WARNED
    line = np.where(ink.mask, np.uint8(0), np.uint8(255))
    if template.shape[0] > line.shape[0] or template.shape[1] > line.shape[1]:
        if not OVERSIZE_WARNED:
            OVERSIZE_WARNED = True
            logger.warning(
                "A template is %dx%d even after trimming, larger than a %dx%d line. "
                "Template matching is skipped on such lines — re-cut the template from this mushaf.",
                template.shape[1],
                template.shape[0],
                line.shape[1],
                line.shape[0],
            )
        logger.info("      template %dx%d does not fit this line; shape detector alone", *template.shape[::-1])
        return None

    # Pinned to the CPU kernel. TM_CCOEFF_NORMED fabricates perfect scores under
    # this project's OpenCL path (see the sura-header investigation), and an
    # engine must not answer differently depending on a process-wide switch some
    # other caller set — so ask for the kernel whose scores can be trusted rather
    # than turning OpenCL off for everyone.
    result = match_template_ccoeff_normed(line, template, force_cpu=True)
    if result.ndim == 2:
        return result.max(axis=0), result.argmax(axis=0)
    return result, np.zeros(result.shape[0], dtype=np.intp)


def find_spans_by_template(
    ink: LineInk,
    template: np.ndarray,
    threshold: float,
) -> list[tuple[int, int]]:
    """The ornament template's hits, as x-spans of the template's width."""
    scored = score_template_columns(ink, template)
    if scored is None:
        return []
    scores, _ = scored
    width = template.shape[1]
    spans: list[tuple[int, int]] = []
    taken = np.zeros(scores.shape[0], dtype=bool)
    best_rejected = None
    while not taken.all():
        masked = np.where(taken, -np.inf, scores)
        idx = int(np.argmax(masked))
        if masked[idx] < threshold:
            best_rejected = (idx, float(masked[idx]))
            break
        logger.debug(
            "      template hit at x=%d..%d score %.3f (threshold %.2f)",
            idx + ink.offset_x,
            idx + width + ink.offset_x,
            float(scores[idx]),
            threshold,
        )
        spans.append((idx, idx + width))
        taken[max(0, idx - width) : min(scores.shape[0], idx + width)] = True
    if best_rejected is not None and logger.isEnabledFor(logging.DEBUG):
        # The near miss is the useful number when a run finds no ornament where
        # the eye sees one: it says whether to move the threshold or the template.
        logger.debug(
            "      best rejected template score %.3f at x=%d (threshold %.2f)",
            best_rejected[1],
            best_rejected[0] + ink.offset_x,
            threshold,
        )
    return spans


@dataclass(frozen=True)
class SymbolHit:
    """A symbol template's match that is a sign of its own: the pieces it is made of."""

    name: str
    score: float
    pieces: list[Blob]


def find_symbol_hits(ink: LineInk, template: np.ndarray, name: str, threshold: float) -> list[SymbolHit]:
    """Every place ``template`` matches and the ink there is a sign of its own.

    Columns are tried best score first. One within a template's width of a sign
    already found is that sign again. One whose ink is not a sign hides nothing
    around it, so a weaker real sign beside a strong false match is still found.
    """
    scored = score_template_columns(ink, template)
    if scored is None:
        return []
    scores, rows = scored
    height, width = template.shape
    hits: list[SymbolHit] = []
    found_at: list[int] = []
    for column in np.argsort(-scores, kind="stable"):
        score = float(scores[column])
        if score < threshold:
            break
        if any(abs(int(column) - other) < width for other in found_at):
            continue
        pieces = find_pieces_of_sign(ink, (int(column), int(rows[column]), width, height))
        logger.debug(
            "      %s hit at x=%d y=%d score %.3f → %s",
            name,
            int(column) + ink.offset_x,
            int(rows[column]) + ink.offset_y,
            score,
            f"{len(pieces)} piece(s) {[b.label for b in pieces]}" if pieces else "not a sign of its own",
        )
        if pieces:
            hits.append(SymbolHit(name=name, score=score, pieces=pieces))
            found_at.append(int(column))
    return hits


def find_pieces_of_sign(ink: LineInk, box: tuple[int, int, int, int]) -> list[Blob]:
    """The pieces of the sign matched at ``box`` (x, y, w, h in the tight crop), or
    none when the ink there is not a sign of its own.

    A piece is the sign's when it lies wholly inside the box grown by
    :data:`SYMBOL_BOX_MARGIN` and its centre lies inside the box itself. The sign is
    believed when those pieces hold :data:`SYMBOL_OWN_INK` of the ink in the box.
    """
    x, y, w, h = box
    margin_x, margin_y = round(SYMBOL_BOX_MARGIN * w), round(SYMBOL_BOX_MARGIN * h)
    pieces = [
        blob
        for blob in ink.components
        if x - margin_x <= blob.x
        and blob.right <= x + w + margin_x
        and y - margin_y <= blob.y
        and blob.bottom <= y + h + margin_y
        and x <= blob.x + blob.w / 2 <= x + w
        and y <= blob.y + blob.h / 2 <= y + h
    ]
    if not pieces:
        return []
    labels = ink.label_map[y : y + h, x : x + w]
    ink_in_box = int(np.count_nonzero(labels))
    own_ink = int(np.isin(labels, [blob.label for blob in pieces]).sum())
    if own_ink < SYMBOL_OWN_INK * ink_in_box:
        return []
    return pieces


def claim_symbol_pieces(hits: list[SymbolHit]) -> list[tuple[str, list[Blob]]]:
    """One group per sign, right to left. Where two templates found the same piece
    the better match names it, and a hit left with no piece of its own goes."""
    claimed: set[int] = set()
    groups: list[tuple[str, list[Blob]]] = []
    for hit in sorted(hits, key=lambda hit: -hit.score):
        pieces = [blob for blob in hit.pieces if blob.label not in claimed]
        if not pieces:
            continue
        claimed.update(blob.label for blob in pieces)
        groups.append((hit.name, pieces))
    return sorted(groups, key=lambda group: -max(blob.right for blob in group[1]))


def measure_hole_fraction(ink: LineInk, blob: Blob) -> float:
    """Largest enclosed hole in a blob, as a share of its bounding box."""
    patch = ink.mask[blob.y : blob.bottom, blob.x : blob.right].astype(np.uint8)
    contours, hierarchy = cv2.findContours(patch, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return 0.0
    # hierarchy[0][i][3] is the parent index; anything with a parent is a hole.
    inner = [cv2.contourArea(c) for c, h in zip(contours, hierarchy[0], strict=True) if h[3] != -1]
    return max(inner) / max(1, blob.w * blob.h) if inner else 0.0


def find_spans_by_shape(ink: LineInk) -> list[tuple[int, int]]:
    """Find the hollow ring. Works wherever on the line the ornament sits.

    The ornament is a closed ring with a digit floating inside it. Letters have
    bowls too, but a bowl is small next to the letter; the ring's hole is most of
    the ornament. That ratio is what separates them.
    """
    if len(ink.bodies) < 3:
        logger.debug("      shape detector needs 3 bodies to judge a median height; this line has %d", len(ink.bodies))
        return []
    median_height = float(np.median([b.h for b in ink.bodies]))
    spans: list[tuple[int, int]] = []
    for blob in ink.bodies:
        aspect = blob.w / max(1, blob.h)
        tall = blob.h >= 1.25 * median_height
        square = 0.55 <= aspect <= 1.9
        if not (tall and square):
            continue
        # Measured last: findContours on a patch is the expensive half of this test.
        hole = measure_hole_fraction(ink, blob)
        logger.debug(
            "      shape candidate #%d x=%d..%d h=%d (median %.0f) aspect %.2f hole %.2f → %s",
            blob.label,
            blob.x + ink.offset_x,
            blob.right + ink.offset_x,
            blob.h,
            median_height,
            aspect,
            hole,
            "ornament" if hole >= HOLE_FRACTION else f"letter (needs {HOLE_FRACTION})",
        )
        if hole >= HOLE_FRACTION:
            spans.append((blob.x, blob.right))
    return spans


def label_spans_with_ayat(ink: LineInk, spans: list[tuple[int, int]]) -> list[str | None]:
    """Which aya each settled span closes, from what the caller supplied.

    Re-attached by position rather than by index: ``merge_overlapping_spans`` can fuse two
    supplied spans into one, so a parallel list would silently desync. Where two
    are fused the later one wins — that ornament closes the later aya, and the
    fused span ends where it ends.

    ``None`` throughout when the caller said nothing, which is every path but the
    database one: a bare directory of PNGs knows no aya numbers.
    """
    supplied = ink.supplied_separator_ayat
    if not supplied or ink.supplied_separators is None:
        return [None] * len(spans)
    labels: list[str | None] = [None] * len(spans)
    for (left, _right), aya in zip(ink.supplied_separators, supplied, strict=False):
        middle = left - ink.offset_x
        for index, (span_left, span_right) in enumerate(spans):
            if span_left <= middle <= span_right:
                labels[index] = aya
                break
    return labels

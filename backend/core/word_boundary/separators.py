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
SYMBOL_MATCH_THRESHOLD = 0.5


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
        spans = _merge_spans([(left - ink.offset_x, right - ink.offset_x) for left, right in ink.supplied_separators])
        logger.info(
            "    ornaments: %d supplied by the caller, detectors skipped — %s",
            len(spans),
            _spans_text(spans, ink.offset_x) or "none",
        )
    else:
        by_template = _separator_spans_by_template(ink, template, match_threshold) if template is not None else []
        by_shape = _separator_spans_by_shape(ink)
        spans = _merge_spans([*by_template, *by_shape])
        logger.info(
            "    ornaments: template found %d, shape found %d, %d after merging — %s",
            len(by_template),
            len(by_shape),
            len(spans),
            _spans_text(spans, ink.offset_x) or "none",
        )
    if not spans:
        return

    # The ring, its digits, and any attached marks share a span, so the parser
    # sees one explicit ornament event rather than several text components.
    ink.separator_spans = spans
    kept, groups, befores = _partition(ink.components, spans)
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


def _spans_text(spans: list[tuple[int, int]], offset_x: int) -> str:
    """Spans as the caller would name them: image coordinates, not the tight crop."""
    return " ".join(f"{left + offset_x}..{right + offset_x}" for left, right in spans)


def _merge_spans(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
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


def _partition(
    components: list[Blob],
    spans: list[tuple[int, int]],
) -> tuple[list[Blob], list[list[Blob]], list[int]]:
    """Split components into those outside every span and those grouped by span.

    Membership is by **centre**, not overlap: a letter whose tail reaches under an
    ornament still belongs to the text, and a dot sitting inside one does not.

    The third return is, for each group, how many text bodies precede it — which
    only the ornament caller needs, since that is what turns a span into a cut
    point once every line's bodies are concatenated. A symbol is not a cut point
    and throws it away.
    """
    kept: list[Blob] = []
    groups: list[list[Blob]] = []
    befores: list[int] = []
    current: tuple[int, int] | None = None
    bodies_before = 0
    for blob in components:
        centre = blob.x + blob.w / 2
        span = next((s for s in spans if s[0] <= centre <= s[1]), None)
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
    not read either as letters, and the removal is the same partition. But an
    ornament also *closes an aya*: ``span.parse_span`` collapses its live readings
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
    """
    if not templates:
        return
    spans: list[tuple[int, int]] = []
    found: list[tuple[str, tuple[int, int]]] = []
    for name, template in templates.items():
        for span in _separator_spans_by_template(ink, template, match_threshold):
            spans.append(span)
            found.append((name, span))
    if not spans:
        return
    spans = _merge_spans(spans)

    kept, groups, _ = _partition(ink.components, spans)
    ink.symbol_spans = spans
    # Name each group by whichever template's hit it overlaps, for the trace only.
    ink.symbols = [
        (next((n for n, s in found if s[0] <= group[0].x + group[0].w / 2 <= s[1]), "symbol"), group)
        for group in groups
    ]
    ink.components = kept
    ink.bodies = [b for b in kept if b.preferred == "body"]
    ink.marks = [b for b in kept if b.preferred != "body"]
    logger.info(
        "    symbols: %d removed from the text ink — %s",
        len(ink.symbols),
        ", ".join(
            f"{name} x={group[0].x + ink.offset_x}..{max(b.right for b in group) + ink.offset_x} ({len(group)} blob(s))"
            for name, group in ink.symbols
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
_OVERSIZE_REPORTED = False


def _separator_spans_by_template(
    ink: LineInk,
    template: np.ndarray,
    threshold: float,
) -> list[tuple[int, int]]:
    global _OVERSIZE_REPORTED
    line = np.where(ink.mask, np.uint8(0), np.uint8(255))
    if template.shape[0] > line.shape[0] or template.shape[1] > line.shape[1]:
        if not _OVERSIZE_REPORTED:
            _OVERSIZE_REPORTED = True
            logger.warning(
                "The separator template is %dx%d even after trimming, larger than a %dx%d line. "
                "Template matching is skipped on such lines — re-cut the template from this mushaf.",
                template.shape[1],
                template.shape[0],
                line.shape[1],
                line.shape[0],
            )
        logger.info("      template %dx%d does not fit this line; shape detector alone", *template.shape[::-1])
        return []

    # Pinned to the CPU kernel. TM_CCOEFF_NORMED fabricates perfect scores under
    # this project's OpenCL path (see the sura-header investigation), and an
    # engine must not answer differently depending on a process-wide switch some
    # other caller set — so ask for the kernel whose scores can be trusted rather
    # than turning OpenCL off for everyone.
    result = match_template_ccoeff_normed(line, template, force_cpu=True)
    width = template.shape[1]
    scores = result.max(axis=0) if result.ndim == 2 else result
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


def _hole_fraction(ink: LineInk, blob: Blob) -> float:
    """Largest enclosed hole in a blob, as a share of its bounding box."""
    patch = ink.mask[blob.y : blob.bottom, blob.x : blob.right].astype(np.uint8)
    contours, hierarchy = cv2.findContours(patch, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return 0.0
    # hierarchy[0][i][3] is the parent index; anything with a parent is a hole.
    inner = [cv2.contourArea(c) for c, h in zip(contours, hierarchy[0], strict=True) if h[3] != -1]
    return max(inner) / max(1, blob.w * blob.h) if inner else 0.0


def _separator_spans_by_shape(ink: LineInk) -> list[tuple[int, int]]:
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
        hole = _hole_fraction(ink, blob)
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

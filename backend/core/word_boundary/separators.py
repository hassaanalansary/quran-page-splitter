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

import sys

import cv2
import numpy as np
from PIL import Image

from core.image_utils import find_content_bbox
from core.opencv_accel import match_template_ccoeff_normed
from core.word_boundary.ink import Blob, LineInk

#: A blob must enclose a hole at least this share of its own box to read as the
#: separator ring. Measured: real ornaments score 0.38, while the worst letter
#: false-positive on a calligraphic line scores 0.04 — a wide, safe margin.
#: Size and fill alone are NOT enough: a swept calligraphic letter can be square
#: and hollow-looking (aspect 1.01, fill 0.17) and would be dropped as a phantom
#: separator on a line that has none.
HOLE_FRACTION = 0.12


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
    else:
        spans = []
        if template is not None:
            spans += _separator_spans_by_template(ink, template, match_threshold)
        spans += _separator_spans_by_shape(ink)
        spans = _merge_spans(spans)
    if not spans:
        return

    def containing(blob: Blob) -> tuple[int, int] | None:
        centre = blob.x + blob.w / 2
        for span in spans:
            if span[0] <= centre <= span[1]:
                return span
        return None

    ink.separator_spans = spans
    kept: list[Blob] = []
    current: tuple[int, int] | None = None
    preferred_bodies = 0
    for blob in ink.components:
        span = containing(blob)
        if span is None:
            kept.append(blob)
            if blob.preferred == "body":
                preferred_bodies += 1
            current = None
            continue
        # The ring, its digits, and any attached marks share a span, so the
        # parser sees one explicit ornament event rather than text components.
        if span != current:
            ink.separators.append([])
            ink.separator_after.append(preferred_bodies)
            current = span
        ink.separators[-1].append(blob)

    ink.components = kept
    ink.bodies = [b for b in kept if b.preferred == "body"]
    ink.marks = [b for b in kept if b.preferred != "body"]


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


def prepare_template(im: Image.Image) -> np.ndarray:
    """The ornament as black ink on white, trimmed to its ink.

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
        raise ValueError("the aya separator template has no ink in it.")
    x, y, w, h = box
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
            print(
                f"warning: the separator template is {template.shape[1]}x{template.shape[0]} even after "
                f"trimming, larger than a {line.shape[1]}x{line.shape[0]} line. Template matching is "
                f"skipped on such lines — re-cut the template from this mushaf.",
                file=sys.stderr,
            )
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
    while not taken.all():
        masked = np.where(taken, -np.inf, scores)
        idx = int(np.argmax(masked))
        if masked[idx] < threshold:
            break
        spans.append((idx, idx + width))
        taken[max(0, idx - width) : min(scores.shape[0], idx + width)] = True
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
        return []
    median_height = float(np.median([b.h for b in ink.bodies]))
    spans: list[tuple[int, int]] = []
    for blob in ink.bodies:
        aspect = blob.w / max(1, blob.h)
        if blob.h >= 1.25 * median_height and 0.55 <= aspect <= 1.9 and _hole_fraction(ink, blob) >= HOLE_FRACTION:
            spans.append((blob.x, blob.right))
    return spans


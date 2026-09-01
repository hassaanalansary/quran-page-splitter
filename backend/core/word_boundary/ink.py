"""A line image reduced to measured ink: blobs, their evidence, and the band.

Nothing here knows about words. It binarises the line, finds the **writing band**
(the densest row, grown outwards while density holds up), takes connected
components, and gives each one a *preferred* role from where it sits plus a
``body_score`` from four weighted features. The score becomes a price, not a
verdict — every component can still be read either way, it merely costs the
distance from what the evidence suggests.

Everything is measured in the **tight crop**: the line is cut down to its first
and last inked row and column, and ``offset_x``/``offset_y`` remember what was
trimmed. They are read off the bitmap, so no caller can supply them and they are
rarely zero — a line arrives cut to the page column, with its ink tight inside.
``engine`` adds them back once, on the way out.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image

from core.word_boundary.calibration import (
    BODY_SCORE_MAX,
    MAX_UNUSED_COMPONENT_COST,
    SCORE_BAND_OVERLAP,
    SCORE_CROSSES_WRITING_LINE,
    SCORE_RELATIVE_AREA,
    SCORE_RELATIVE_HEIGHT,
)
from core.word_boundary.inputs import LineImage


@dataclass
class Blob:
    """One connected region of ink, in tight-crop coordinates."""

    label: int
    x: int
    y: int
    w: int
    h: int
    area: int
    #: Evidence derived from the baseline band before text parsing.
    preferred: str = "mark-only"
    #: Smaller than the smallest component crossing this line's writing line.
    small_for_body: bool = False
    #: Weighted evidence that this is a letter body, 0..BODY_SCORE_MAX. Reading a
    #: component against its evidence costs the distance from that end of the
    #: scale, so nothing is ever forbidden — only priced.
    body_score: int = 0

    @property
    def cost_as_body(self) -> int:
        return BODY_SCORE_MAX - self.body_score

    @property
    def cost_as_mark(self) -> int:
        # Capped, and this cap is the single most sensitive number in the file.
        # Leaving a body-looking component unused has to stay cheap, because a
        # line routinely carries a stroke or two more than its text accounts for
        # (a letter whose ink broke in two). Charge full price for ignoring them
        # and the parser buys an extra word just to consume them — page 161 line
        # 1 took ten words instead of nine at any count weight. Too cheap and the
        # opposite happens: real letters get discarded and words starve. Measured
        # across 1..14, only 6 reproduces every verified line and lands on
        # exactly the span's word total.
        return min(self.body_score, MAX_UNUSED_COMPONENT_COST)

    #: Role selected by the line parser.  ``None`` means the line was unresolved.
    role: str | None = None
    #: An equal-cost parse assigned this component a different role.
    role_ambiguous: bool = False

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    @property
    def fill(self) -> float:
        return self.area / max(1, self.w * self.h)


@dataclass
class LineInk:
    """A line image reduced to bodies (letter skeletons) and marks (tashkeel)."""

    #: Short name for report rows, and the provenance string for the JSON report.
    label: str
    source: str
    mask: np.ndarray
    offset_x: int
    offset_y: int
    #: Row of the densest horizontal ink profile, in tight-crop coordinates.
    peak: int
    bodies: list[Blob]
    marks: list[Blob]
    #: All non-ornament components.  ``bodies`` and ``marks`` are the current
    #: rendering classification and are rebuilt after parsing.
    components: list[Blob]
    band: tuple[int, int]
    #: Blobs making up each detected ornament, one list per separator.
    separators: list[list[Blob]] = field(default_factory=list)
    #: For each separator, how many text bodies of this line precede it. This is
    #: what lets a separator become a cut point in the concatenated blob sequence.
    separator_after: list[int] = field(default_factory=list)
    #: Horizontal ornament spans, retained to build parser events.
    separator_spans: list[tuple[int, int]] = field(default_factory=list)
    #: Ornament spans the caller already knew, in image coordinates. When present
    #: the detectors do not run at all — see ``split_separators``.
    supplied_separators: list[tuple[int, int]] | None = None


def load_ink(im: Image.Image, alpha_threshold: int = 40) -> np.ndarray:
    """Boolean ink mask. Uses alpha for the pipeline's transparent PNG exports,
    Otsu on greyscale for anything else."""
    arr = np.array(im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im)
    if arr.ndim == 3 and arr.shape[2] == 4 and arr[..., 3].min() < 255:
        return arr[..., 3] > alpha_threshold
    grey = np.array(im.convert("L"))
    _, binary = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    return binary > 0


def analyse_line(
    line: LineImage,
    *,
    band_density: float = 0.30,
) -> LineInk:
    """Split a line's ink into baseline bodies and floating marks.

    A blob is a body when it **reaches the writing line**, and a mark when it
    floats clear of it.

    There is deliberately no size test. Height, width and area were all tried
    and all rejected: in a hand-set mushaf a single mark can cover more area
    than a letter, and one swept letter more than a whole short word, so no
    cutoff on size is defensible. Two real failures came from exactly that — a
    fatha 43px tall was promoted to a body because it cleared a height cutoff,
    while a genuine ``نت`` only 27px tall was demoted to a mark because it did
    not.

    Position separates them where size cannot: both those blobs are the same
    kind of shape, but the fatha stops short of the writing line (bottom 64 of a
    band midline at 79) and the ``نت`` sits squarely on it (bottom 93). The band
    is measured from this line's own ink, so nothing here is a fixed constant.
    """
    mask = load_ink(line.image)
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        return LineInk(
                label=line.label,
            source=line.source,
            mask=mask,
            offset_x=0,
            offset_y=0,
            peak=0,
            bodies=[],
            marks=[],
            components=[],
            band=(0, 0),
            supplied_separators=line.separators,
        )

    offset_y, offset_x = int(rows[0]), int(cols[0])
    tight = mask[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]
    height = tight.shape[0]

    # Baseline band: densest row, grown out while density holds up.
    profile = tight.sum(axis=1)
    peak = int(profile.argmax())
    floor = profile[peak] * band_density
    top = peak
    while top > 0 and profile[top - 1] >= floor:
        top -= 1
    bottom = peak
    while bottom < height - 1 and profile[bottom + 1] >= floor:
        bottom += 1
    # ``connectivity`` by name: positionally that slot is ``labels``, and while
    # OpenCV's overload dispatch sorts an int out at run time, the stubs cannot.
    count, _, stats, _ = cv2.connectedComponentsWithStats(tight.astype(np.uint8), connectivity=8)
    components: list[Blob] = []
    for k in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[k])
        # The preferred role is evidence, not a hard classification.  In
        # particular, a component crossing the densest row can still be a mark;
        # the parser may demote it at a cost of one when exact PAW accounting
        # requires that reading.
        spans_peak = y <= peak < y + h
        touches_band = y <= bottom and y + h > top
        preferred = "body" if spans_peak else ("mark" if touches_band else "mark-only")
        components.append(Blob(label=k, x=x, y=y, w=w, h=h, area=area, preferred=preferred))

    # Score every component against this line's own geometry. Height, width and
    # area are back, but as weighted evidence rather than the gates they used to
    # be: a component below any of these is still free to be read as a body, it
    # simply costs the distance. That is what stops one odd letter from breaking
    # a line, while still letting a dot be recognised as a dot.
    band_height = max(1, bottom - top + 1)
    crossing = [b.area for b in components if b.preferred == "body"]
    typical_area = float(np.median(crossing)) if crossing else 1.0
    smallest_crossing = min(crossing, default=0)
    for blob in components:
        overlap = max(0, min(blob.bottom, bottom + 1) - max(blob.y, top))
        blob.small_for_body = blob.preferred != "body" and blob.area < smallest_crossing
        blob.body_score = round(
            SCORE_CROSSES_WRITING_LINE * (1.0 if blob.preferred == "body" else 0.0)
            + SCORE_BAND_OVERLAP * min(1.0, overlap / max(1, blob.h))
            + SCORE_RELATIVE_AREA * min(1.0, blob.area / max(1.0, typical_area))
            + SCORE_RELATIVE_HEIGHT * min(1.0, blob.h / band_height)
        )

    components.sort(key=lambda b: -b.right)  # right-to-left
    bodies = [b for b in components if b.preferred == "body"]
    marks = [b for b in components if b.preferred != "body"]
    return LineInk(
        label=line.label,
        source=line.source,
        mask=tight,
        offset_x=offset_x,
        offset_y=offset_y,
        peak=peak,
        bodies=bodies,
        marks=marks,
        components=components,
        band=(top, bottom),
        supplied_separators=line.separators,
    )


def attach_marks(ink: LineInk) -> dict[int, list[Blob]]:
    """Give every mark to the body it sits over, so tashkeel travels with its letter."""
    owned: dict[int, list[Blob]] = {body.label: [] for body in ink.bodies}
    if not ink.bodies:
        return owned
    for mark in ink.marks:
        centre = mark.x + mark.w / 2
        best, best_distance = ink.bodies[0].label, float("inf")
        for body in ink.bodies:
            if body.x <= centre <= body.right:
                distance = abs(centre - (body.x + body.w / 2))
            else:
                # Outside every body's span: fall back to nearest edge, but rank
                # strictly below any true containment.
                distance = min(abs(centre - body.x), abs(centre - body.right)) + 10_000
            if distance < best_distance:
                best, best_distance = body.label, distance
        owned[best].append(mark)
    return owned


"""What the word-boundary engine returns: data, and nothing else.

No PIL image, no numpy array, no engine internals. A consumer gets dataclasses of
ints and strings, which is what lets the next phase write word coordinates to the
database without importing anything that draws pictures.

**Every coordinate here is in the input image's own space.** Internally the engine
crops each line tight to its ink and measures from there; the offsets are added
back once, on the way out, so nothing downstream has to know that crop existed.
``WordLine.crop_offset`` still reports it, for debugging.

Words refer to components by ``id`` rather than repeating their geometry: the
words are the product, the components are the evidence, and both ship.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class InkComponent:
    """One connected region of ink, as the engine finally read it."""

    #: Connected-component label. What ``WordBox.components`` and
    #: ``Ornament.components`` point at.
    id: int
    x: int
    y: int
    w: int
    h: int
    #: "body" — a letter; "mark" — tashkeel or i'jam; "ornament" — part of an aya
    #: separator, which is not text at all.
    role: str
    #: The two cheapest readings disagreed about this component's role.
    ambiguous: bool = False
    #: Weighted evidence that this is a letter body, 0..BODY_SCORE_MAX. Measured
    #: before any parsing, so an ornament carries one too — it simply never got
    #: to argue its case.
    body_score: int = 0

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h


@dataclass(frozen=True)
class Ornament:
    """One aya separator: the ring, its digits, and anything attached to them."""

    #: ``InkComponent.id`` of every piece, in right-to-left order.
    components: list[int]
    left: int
    right: int


@dataclass(frozen=True)
class WordBox:
    """One word of the stream, placed on a line."""

    #: Position in the word stream the engine was given.
    index: int
    text: str
    #: "7:82".
    aya: str
    #: ``quran.Word.id`` when the stream came from the database; ``None`` from a
    #: text file. This is what lets a caller write results back to a row.
    word_id: int | None
    #: PAW count the spelling demands, against which ``components`` can be judged.
    expected_paws: int
    #: The bodies assigned to this word. Empty when it ran together with a
    #: neighbour and took no ink of its own — see ``merged``.
    components: list[int]
    x: int
    y: int
    w: int
    h: int
    #: Where the word ends, which is where a cut goes. Arabic runs right to left,
    #: so this is the box's left edge.
    end_x: int

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def merged(self) -> bool:
        """No ink of its own — it ran together with a neighbour."""
        return not self.components


@dataclass(frozen=True)
class WordSegment:
    """One ornament-delimited stretch of a line, as it parsed.

    A line is parsed in stretches, not as a whole, so a fused word ahead of an
    ornament cannot discard the perfectly determined words behind it. When a line
    comes back ``partial`` this is what says which stretches survived.
    """

    status: str
    reason: str | None
    #: How many words this stretch accounted for.
    words: int
    end_sequences: int
    deviations: int = 0

    @property
    def resolved(self) -> bool:
        return self.status != "unresolved"


@dataclass(frozen=True)
class WordLine:
    """One input line, as the engine read it."""

    label: str
    source: str
    #: exact | scored | partial | unresolved.
    status: str
    #: Why it is not ``exact``. ``None`` when it is.
    reason: str | None
    #: Total evidence cost of the winning reading. ``None`` when nothing parsed.
    cost: int | None
    #: Words that closed on more or fewer blobs than their spelling demands. The
    #: honest quality signal — cost alone grows with line length.
    deviations: int
    #: Depth of the ties, counted only where there was one.
    end_sequences: int
    #: The writing band, top and bottom, in image coordinates.
    band: tuple[int, int]
    #: The blank margin ``analyse_line`` measured off before working, as
    #: ``(x, y)``. Already applied to everything above and below; reported so a
    #: debugging caller can see what was trimmed.
    crop_offset: tuple[int, int]
    #: Every component of the line. Bodies and marks come first, in right-to-left
    #: order; ornament pieces follow.
    components: list[InkComponent] = field(default_factory=list)
    ornaments: list[Ornament] = field(default_factory=list)
    #: Empty for an unresolved line — no boundaries were drawn.
    words: list[WordBox] = field(default_factory=list)
    segments: list[WordSegment] = field(default_factory=list)


@dataclass(frozen=True)
class WordBoundaryResult:
    """One run of the engine over one span of ayat."""

    lines: list[WordLine]
    #: How far through the word stream the run got.
    words_consumed: int
    #: The whole stream was accounted for. False means the last line's cuts were
    #: withdrawn rather than reported as a plausible reading of an incomplete span.
    complete: bool

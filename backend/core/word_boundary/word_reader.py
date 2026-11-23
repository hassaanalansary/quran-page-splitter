"""Reading one word: what each of its blobs holds.

Pure: plain data in, plain data out.

The line search has given the word its blobs — bodies and marks. The reader says what
each one holds, as a contents key (:mod:`core.text.contents`), by one rule for every
case: a plain letter, a mark, a letter with its mark touching, two pieces printed as
one::

    1. pack the bodies   the word's pieces split over its bodies, in reading order:
                         each body takes a run of consecutive pieces (إلا's one body
                         takes both)
    2. place the marks   each mark the text names goes to a mark blob, inside the body
                         that holds its letter, or nowhere (mark_check's assignment)
    3. price it          shape — how near each blob is to the library's pictures of
                         what it is said to hold
                         habit — how this hand prints those joins and marks (habits)
                         place — how far each mark sits from its letter
    4. keep the best     and the runner-up: how far apart they are is how sure the
                         reader is (``gap``)

Nothing a person decided is ever changed: a decided part narrows what may be tried.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

from core.text.contents import ContentsKey, parts_of
from core.text.marks import TextMark
from core.word_boundary.habits import (
    HabitCounts,
    MarkPlace,
    chance_of_mark_place,
    chance_of_touching,
    expect_mark_places,
)
from core.word_boundary.mark_check import MISSING, Carrier, FoundMark, SlotPrices, WordCheck, check_word

#: A body that holds none of the word's pieces: a broken stroke, or ink of no letter.
EXTRA_BODY = 0.5
#: A body the library has pictures of, but not of these letters.
UNKNOWN_BODY = 0.3
#: A body holding a mark the library has no picture of it holding.
UNKNOWN_HOLD = 0.6
#: Weight of a join's habit: a join against everything seen costs this much.
JOIN_WEIGHT = 1.0
#: Weight of a mark's habit, in the mark check's units.
MARK_WEIGHT = 0.5
#: The packings, cheapest by their bodies, whose marks are placed too.
PACKINGS_TRIED = 4
#: More packings than this and the word is read in order, one piece per body.
MOST_PACKINGS = 5000
#: Two readings closer than this, or a word whose marks do not fit, is unsure.
UNSURE_GAP = 0.15
#: The gap of a word with only one way to read it.
NO_RIVAL_GAP = 1.0
#: A body's choice between holding a mark of its letters and holding none, closer than
#: this, is a doubt.
CARRIER_MARGIN = 0.15


@dataclass(frozen=True)
class WordText:
    """What the text says the word is."""

    letters: str
    paws: tuple[str, ...]
    marks: tuple[TextMark, ...]


@dataclass(frozen=True)
class BodyPiece:
    """One body the line search gave the word."""

    id: int
    right: float
    left: float
    decided: ContentsKey = field(default_factory=ContentsKey)
    #: The library's distance from this blob to each key it was compared with, the
    #: borrowed pictures already in. Empty when the library had nothing to say.
    distances: dict[ContentsKey, float] = field(default_factory=dict)


@dataclass
class WordReading:
    keys: dict[int, ContentsKey]
    check: WordCheck
    cost: float
    gap: float
    unsure: bool
    #: Blobs whose reading was a close call (:func:`find_doubtful_blobs`).
    doubtful: set[int] = field(default_factory=set)


Packing = tuple[tuple[int, int], ...]


def list_body_packings(pieces: tuple[str, ...], bodies: list[BodyPiece]) -> Iterator[Packing]:
    """Every way to split the word's pieces over its bodies, right to left: each body a
    run ``(start, end)`` of consecutive pieces. A body takes none only when there are
    more bodies than pieces left. A person's decided count or letters must hold."""
    total = len(pieces)

    def walk(index: int, at: int) -> Iterator[Packing]:
        if index == len(bodies):
            if at == total:
                yield ()
            return
        left_bodies = len(bodies) - index
        left_pieces = total - at
        decided = bodies[index].decided.bodies
        for take in range(0, left_pieces + 1):
            if take == 0 and left_pieces >= left_bodies:
                continue
            if decided is not None and decided != (None,) and take != len(decided):
                continue
            if decided and decided != (None,):
                run = pieces[at : at + take]
                if any(said is not None and said != piece for said, piece in zip(decided, run, strict=True)):
                    continue
            for rest in walk(index + 1, at + take):
                yield ((at, at + take), *rest)

    return walk(0, 0)


def price_body_shape(body: BodyPiece, run: tuple[str, ...]) -> float:
    """How unlike its pictures of ``run`` the body is, against its nearest picture of
    anything: 0 when ``run`` is what it looks most like."""
    if not body.distances:
        return 0.0
    best = min(body.distances.values())
    own = [distance for key, distance in body.distances.items() if key.bodies == run]
    if not own:
        return UNKNOWN_BODY
    return min(1.0, min(own) - best)


def price_packing_bodies(text: WordText, bodies: list[BodyPiece], packing: Packing, habits: HabitCounts) -> float:
    """What a packing costs before its marks: each body's shape, and each join's habit."""
    cost = 0.0
    owner_of_piece: dict[int, int] = {}
    for index, (body, (start, end)) in enumerate(zip(bodies, packing, strict=True)):
        if start == end:
            cost += EXTRA_BODY
            continue
        cost += price_body_shape(body, text.paws[start:end])
        for piece in range(start, end):
            owner_of_piece[piece] = index
    for join in range(len(text.paws) - 1):
        chance = chance_of_touching(habits, text.letters, text.paws, join)
        together = join in owner_of_piece and owner_of_piece.get(join) == owner_of_piece.get(join + 1)
        cost += JOIN_WEIGHT * ((1.0 - chance) if together else chance)
    return cost


def place_letters(text: WordText, bodies: list[BodyPiece], packing: Packing) -> list[float]:
    """Where each letter sits: spread evenly over the body that holds its piece."""
    starts = []
    seen = 0
    for piece in text.paws:
        starts.append(seen)
        seen += len(piece)
    positions = [0.0] * len(text.letters)
    filled = [False] * len(text.letters)
    for body, (start, end) in zip(bodies, packing, strict=True):
        if start == end:
            continue
        first = starts[start]
        count = sum(len(piece) for piece in text.paws[start:end])
        width = max(body.right - body.left, 1.0)
        for offset in range(count):
            if first + offset < len(positions):
                positions[first + offset] = body.right - (offset + 0.5) * width / count
                filled[first + offset] = True
    if bodies and not all(filled):
        right = max(body.right for body in bodies)
        left = min(body.left for body in bodies)
        count = max(len(positions), 1)
        for index, done in enumerate(filled):
            if not done:
                positions[index] = right - (index + 0.5) * (right - left) / count
    return positions


def build_carriers(text: WordText, bodies: list[BodyPiece], packing: Packing, habits: HabitCounts) -> list[Carrier]:
    """The bodies that may hold a mark of their own letters, each with what holding
    each kind costs it."""
    starts = []
    seen = 0
    for piece in text.paws:
        starts.append(seen)
        seen += len(piece)
    carriers = []
    for body, (start, end) in zip(bodies, packing, strict=True):
        if start == end:
            continue
        first = starts[start]
        letters = frozenset(range(first, first + sum(len(piece) for piece in text.paws[start:end])))
        own = [mark for mark in text.marks if mark.letter in letters]
        decided_marks = body.decided.marks
        if not own and not decided_marks:
            continue
        run = text.paws[start:end]
        variants = {key.marks: distance for key, distance in body.distances.items() if key.bodies == run}
        best = min(variants.values()) if variants else 0.0
        holds = {}
        for mark in own:
            distance = variants.get((mark.kind,))
            holds[mark.kind] = min(1.0, distance - best) if distance is not None else UNKNOWN_HOLD
        plain = variants.get(())
        carriers.append(
            Carrier(
                id=body.id,
                letters=letters,
                x=(body.right + body.left) / 2,
                holds=holds,
                plain=min(1.0, plain - best) if plain is not None and variants else 0.0,
                fixed=tuple(kind for kind in decided_marks or () if kind is not None),
                holds_nothing=decided_marks == (),
            )
        )
    return carriers


def price_marks_by_habit(text: WordText, habits: HabitCounts) -> dict[int, SlotPrices]:
    """What each text mark costs, by where the ink puts it, from this hand's habits."""
    prices = {}
    for index, mark in enumerate(text.marks):
        prior = expect_mark_places(optional=mark.optional)

        def chance(place: MarkPlace, mark: TextMark = mark, prior: dict[str, float] = prior) -> float:
            return chance_of_mark_place(habits, text.letters, mark.letter, mark.kind, place, prior)

        alone = chance("alone") + chance("joined")
        missing = chance("missing")
        prices[index] = SlotPrices(
            alone=MARK_WEIGHT * (1.0 - min(1.0, alone)),
            inside=MARK_WEIGHT * (1.0 - chance("inside")),
            missing=MISSING * max(0.0, 1.0 - 2.0 * missing),
        )
    return prices


def write_word_keys(
    bodies: list[BodyPiece], packing: Packing, text: WordText, marks: list[FoundMark], check: WordCheck
) -> dict[int, ContentsKey]:
    keys: dict[int, ContentsKey] = {}
    for body, (start, end) in zip(bodies, packing, strict=True):
        if start == end:
            keys[body.id] = ContentsKey((None,), ())
            continue
        keys[body.id] = ContentsKey(text.paws[start:end], tuple(check.inside.get(body.id, [])))
    for mark in marks:
        kind = check.types.get(mark.id) or mark.typed or mark.likeliest
        keys[mark.id] = ContentsKey((), tuple(parts_of(kind)) if kind else (None,))
    return keys


def read_word(
    text: WordText,
    bodies: list[BodyPiece],
    marks: list[FoundMark],
    *,
    width: float,
    habits: HabitCounts,
) -> WordReading:
    """What each of a word's blobs holds — see the module docstring. ``width`` is the
    word's width, in the units of the blobs' x."""
    bodies = sorted(bodies, key=lambda body: -body.right)
    packings: list[Packing] = []
    for packing in list_body_packings(text.paws, bodies):
        packings.append(packing)
        if len(packings) > MOST_PACKINGS:
            packings = []
            break
    if not packings:
        packings = [read_in_order(text, bodies)]
    priced = sorted(
        ((price_packing_bodies(text, bodies, packing, habits), packing) for packing in packings),
        key=lambda item: item[0],
    )[:PACKINGS_TRIED]
    prices = price_marks_by_habit(text, habits)
    readings: list[tuple[float, Packing, WordCheck, list[Carrier]]] = []
    for body_cost, packing in priced:
        carriers = build_carriers(text, bodies, packing, habits)
        check = check_word(
            list(text.marks),
            place_letters(text, bodies, packing),
            width,
            marks,
            carriers=carriers,
            prices=prices,
        )
        readings.append((body_cost + check.cost, packing, check, carriers))
    readings.sort(key=lambda item: item[0])
    cost, packing, check, carriers = readings[0]
    keys = write_word_keys(bodies, packing, text, marks, check)
    rivals = [
        total
        for total, other, other_check, _ in readings[1:]
        if write_word_keys(bodies, other, text, marks, other_check) != keys
    ]
    gap = (rivals[0] - cost) if rivals else NO_RIVAL_GAP
    doubtful = find_doubtful_blobs(text, check, carriers, prices, marks)
    return WordReading(
        keys=keys,
        check=check,
        cost=cost,
        gap=gap,
        unsure=gap < UNSURE_GAP or not check.clean or bool(doubtful),
        doubtful=doubtful,
    )


def find_doubtful_blobs(
    text: WordText, check: WordCheck, carriers: list[Carrier], prices: dict[int, SlotPrices], marks: list[FoundMark]
) -> set[int]:
    """The blobs whose reading was a close call:

    * a mark the text types otherwise than the shape it looks most like — where two
      marks over one letter swap, or a pause sign is read as a dot;
    * a body whose choice between holding a mark of its letters and holding none was
      within ``CARRIER_MARGIN`` — a round zero or a hamza touching its alef or not.

    A person's decisions are never doubted here."""
    doubtful: set[int] = set()
    for mark in marks:
        kind = check.types.get(mark.id)
        if mark.typed or not kind or not mark.scores:
            continue
        if mark.likeliest and mark.likeliest not in parts_of(kind) and kind != mark.likeliest:
            doubtful.add(mark.id)
    for carrier in carriers:
        if carrier.fixed or carrier.holds_nothing:
            continue
        held = set(check.inside.get(carrier.id, []))
        for index, named in enumerate(text.marks):
            if named.letter not in carrier.letters or named.kind not in carrier.holds:
                continue
            price = prices.get(index, SlotPrices())
            missing = price.missing if price.missing is not None else 0.0
            elsewhere = named.kind in check.types.values()
            hold = carrier.holds[named.kind] + price.inside
            apart = carrier.plain + (price.alone if elsewhere else missing)
            if abs(hold - apart) < CARRIER_MARGIN and (named.kind in held or not elsewhere):
                doubtful.add(carrier.id)
    return doubtful


def read_in_order(text: WordText, bodies: list[BodyPiece]) -> Packing:
    """The plain reading when nothing else fits: one piece per body, right to left; the
    last body takes what is left, extra bodies take none."""
    packing = []
    at = 0
    for index in range(len(bodies)):
        take = 1 if at < len(text.paws) else 0
        if index == len(bodies) - 1:
            take = len(text.paws) - at
        packing.append((at, at + take))
        at += take
    return tuple(packing)

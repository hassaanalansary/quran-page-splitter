"""A word's marks in the ink against the marks its text names — forced alignment, for marks.

The engine matches letters to ink by alignment: the text says how many pieces a word
prints. The Uthmani text also names every mark, letter by letter
(:func:`core.text.marks.text_marks`), so the same can be done for the marks: the marks
the reading gave a word against the marks its text says it has. What comes back gives
each mark the type its text names for it, says when that is *sure*, and names what does
not fit — a mark the text expects and the ink lacks, ink the text has no mark for, a
typed mark the text calls something else.

It is an assignment — each mark of ink to one *slot* of the text's, at the least total
cost::

    cost = how unlike the slot's type the ink looks    (the type matcher's score for
                                                         it, less its best score)
         + how far it sits from the slot's letter       (as a share of the word's width)
         + whether it is on the slot's side of the line (on it, for above or below: a
                                                         little; above for below: never)
         + how this hand usually prints that mark       (``SlotPrices``: alone, inside
                                                         its letter, or not at all)

A slot left empty costs its ``missing`` price — by default nothing when its mark may
leave no ink of its own (the hamza drawn inside its alef), and ``MISSING`` otherwise;
ink left over costs ``EXTRA``, a pause sign much less (readings pause in different
places). A mark may come in pieces — a tanween's two strokes, a dot group's dots, the
three dots of the embraced pause — and each piece is a slot, the first required and the
rest free. One blob may be two marks touching — a hamza and its kasra — when it is typed
so, or looks most like such a pair: it then takes two slots.

A mark may also be printed *inside its letter* — a round zero touching its alef, one
blob with it. A body that may hold the mark enters as a **carrier** (``Carrier``): it
fills the slot of a mark on one of its own letters at the price of looking like that
letter with that mark, against looking like the letter alone.

Pure: plain data in, plain data out. The Hungarian method solves each word exactly; a
word has a few dozen slots at most.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from core.text.contents import compound, parts_of
from core.text.marks import DOTTED_PAUSES, Lane, TextMark

#: Pause signs: a reading's, not the text's alone, so never counted against a word.
PAUSE_KINDS = frozenset({"waqfSili", "waqfQili", "waqfJim", "waqfMim", "waqfLa", "waqfMuanaqa"})
#: Costs, in the type matcher's units: a close example lies about 0.1 away.
W_POSITION = 0.6  # per word's width between the ink and its slot's letter
LINE_LANE = 0.25  # ink on the line in a slot above or below it, or the other way round
MISSING = 0.5  # a mark the text requires, with no ink
EXTRA = 0.5  # ink the text has no mark for
EXTRA_PAUSE = 0.1  # a pause sign the text does not have
DISAGREE = 0.3  # a typed mark in a slot of another type, before how unlike that type it looks
UNKNOWN = 0.15  # the matcher has no example of the slot's type
IMPOSSIBLE = 1e6  # above the line for below it, or the other way
#: A type is sure only if the matcher does not prefer another by more than this.
SURE_MARGIN = 0.2


@dataclass(frozen=True)
class FoundMark:
    """One mark of ink the reading gave the word."""

    id: int
    #: Its middle, in the same units as the letters' positions.
    x: float
    lane: Lane
    #: The type it is typed as — by a person, or by the text — or "".
    typed: str = ""
    #: The type matcher's score for each type it has examples of: lower is likelier.
    scores: dict[str, float] = field(default_factory=dict)
    #: A type the ink's arrangement says, whatever its shape: three loose dots in a
    #: triangle are the embraced pause sign, though each dot looks like any other.
    hint: str = ""

    @property
    def likeliest(self) -> str:
        """What it is taken for by shape: typed, else hinted, else the matcher's best."""
        if self.typed:
            return self.typed
        if self.hint:
            return self.hint
        return min(self.scores, key=lambda kind: (self.scores[kind], kind)) if self.scores else ""


@dataclass(frozen=True)
class Carrier:
    """A body that may hold some of its letters' marks inside its ink.

    ``letters`` are the word's letter positions (``letters_of`` order) the body is;
    ``holds`` is what each mark kind costs it to hold — how much more it looks like its
    letters with that mark than like its letters alone, the hand's habit added; a kind
    not listed it cannot hold. ``plain`` is what it costs to hold nothing. ``fixed``
    are kinds a person said it holds: those it must."""

    id: int
    letters: frozenset[int]
    x: float
    holds: dict[str, float] = field(default_factory=dict)
    plain: float = 0.0
    fixed: tuple[str, ...] = ()
    #: Kinds a person said it does *not* hold: a decided key with nothing touching.
    holds_nothing: bool = False


@dataclass(frozen=True)
class SlotPrices:
    """What one text mark costs, by where the ink puts it: its own blob, inside its
    letter, or nowhere. ``None`` keeps the default for that place."""

    alone: float = 0.0
    inside: float = 0.0
    missing: float | None = None


@dataclass
class WordCheck:
    """What the text makes of one word's marks."""

    #: Blob id → the type the text names for it.
    types: dict[int, str] = field(default_factory=dict)
    #: Carrier body id → the marks it holds inside its ink, in ``COMPOUND_ORDER``.
    inside: dict[int, list[str]] = field(default_factory=dict)
    #: The blobs that are strokes of a tanween, each typed as the vowel it looks like.
    tanween: set[int] = field(default_factory=set)
    #: The blobs whose text type is sure: the word fits its text, and the matcher does
    #: not say otherwise.
    sure: set[int] = field(default_factory=set)
    #: Marks the text requires and the ink lacks.
    missing: list[TextMark] = field(default_factory=list)
    #: Ink the text has no mark for (pause signs aside).
    extra: list[int] = field(default_factory=list)
    #: Typed marks the text calls something else.
    disagree: list[int] = field(default_factory=list)
    #: What the whole assignment cost.
    cost: float = 0.0

    @property
    def clean(self) -> bool:
        return not self.missing and not self.extra and not self.disagree


@dataclass(frozen=True)
class MarkSlot:
    mark: int
    kinds: frozenset[str]
    required: bool
    x: float
    lane: Lane
    #: The letter the mark sits on, in ``letters_of`` order.
    letter: int = 0
    #: A pause sign sits over the word's end, or the gap after it: where it lies within
    #: the word says nothing.
    anywhere: bool = False
    #: The first piece of its mark: the one a habit price applies to.
    first: bool = True


def build_slots(expected: list[TextMark], letter_x: list[float]) -> list[MarkSlot]:
    """One slot per piece of every mark the text names, at its letter's place."""
    slots: list[MarkSlot] = []
    for index, mark in enumerate(expected):
        x = letter_x[min(max(mark.letter, 0), len(letter_x) - 1)] if letter_x else 0.0
        if mark.kind == "tanween":
            # A joined pair is one blob of its own shape; apart, each stroke is its
            # vowel's — the dammatan's second one a curl of its own.
            accepted = [frozenset({"tanween", mark.base}), frozenset({mark.base, "other"})]
        elif mark.kind == "waqfMuanaqa":
            accepted = [frozenset({"waqfMuanaqa", "ijamDot"})] * mark.pieces
        elif mark.kind in DOTTED_PAUSES:
            # The sign, then its dots apart — which look like any letter's dots.
            accepted = [frozenset({mark.kind}), frozenset({mark.kind, "ijamDot"})]
        else:
            accepted = [frozenset({mark.kind})] * mark.pieces
        anywhere = mark.kind in PAUSE_KINDS
        for piece, kinds in enumerate(accepted):
            required = piece == 0 and not mark.optional
            slots.append(MarkSlot(index, kinds, required, x, mark.lane, mark.letter, anywhere, first=piece == 0))
    return slots


def list_mark_items(found: list[FoundMark]) -> list[tuple[FoundMark, str]]:
    """Each mark of ink as it enters the assignment: a blob typed, or looking most
    like, marks printed as one enters once per part, fixed to that part."""
    items: list[tuple[FoundMark, str]] = []
    for mark in found:
        kind = mark.likeliest
        if "+" in kind:
            items.extend((mark, part) for part in parts_of(kind))
        else:
            items.append((mark, ""))
    return items


def price_shape(mark: FoundMark, fixed: str, kinds: frozenset[str]) -> float:
    kind = fixed or mark.typed
    if kind:
        # Typed as another type: a slip of the hand, or an old name, when the ink
        # looks like the slot's type — another mark altogether when it does not.
        return 0.0 if kind in kinds else DISAGREE + measure_likeness(mark, kinds)
    if mark.hint:
        return 0.0 if mark.hint in kinds else DISAGREE
    return measure_likeness(mark, kinds)


def measure_likeness(mark: FoundMark, kinds: frozenset[str]) -> float:
    """How far the ink is from looking like the likeliest of ``kinds``, by the matcher:
    0 when one of them is what it looks most like."""
    if not mark.scores:
        return UNKNOWN
    best = min(mark.scores.values())
    return min(min(1.0, mark.scores[kind] - best) if kind in mark.scores else UNKNOWN for kind in kinds)


def price_item_in_slot(mark: FoundMark, fixed: str, slot: MarkSlot, width: float) -> float:
    if mark.lane == slot.lane:
        lane = 0.0
    elif "line" in (mark.lane, slot.lane):
        lane = LINE_LANE
    else:
        return IMPOSSIBLE
    position = 0.0 if slot.anywhere else W_POSITION * abs(mark.x - slot.x) / max(width, 1.0)
    return lane + position + price_shape(mark, fixed, slot.kinds)


def price_carrier_in_slot(carrier: Carrier, slot: MarkSlot, expected: list[TextMark]) -> float:
    """A body holding a slot's mark: only a mark of one of its own letters, only the
    first piece of it, only a kind it can hold."""
    text = expected[slot.mark]
    if not slot.first or text.letter not in carrier.letters or carrier.holds_nothing:
        return IMPOSSIBLE
    if text.kind in carrier.fixed:
        return 0.0
    price = carrier.holds.get(text.kind)
    return IMPOSSIBLE if price is None else price


def price_left_over(mark: FoundMark, fixed: str) -> float:
    return EXTRA_PAUSE if (fixed or mark.likeliest) in PAUSE_KINDS else EXTRA


def price_missing_slot(slot: MarkSlot, prices: dict[int, SlotPrices]) -> float:
    """An empty slot: its mark's habit price for being left out, on its first piece;
    otherwise the default — ``MISSING`` when required, free when not."""
    price = prices.get(slot.mark)
    if price is not None and price.missing is not None and slot.first:
        return price.missing
    return MISSING if slot.required else 0.0


def check_word(
    expected: list[TextMark],
    letter_x: list[float],
    width: float,
    found: list[FoundMark],
    *,
    carriers: Sequence[Carrier] = (),
    prices: dict[int, SlotPrices] | None = None,
) -> WordCheck:
    """Match one word's ink marks to its text's marks — see the module docstring.

    ``letter_x`` is where each letter of the word's skeleton sits (``letters_of``
    order), and ``width`` the word's width, in the units of ``FoundMark.x``.
    ``carriers`` are bodies that may hold their letters' marks; ``prices`` the hand's
    habit for each text mark, by its index in ``expected``.
    """
    prices = prices or {}
    slots = build_slots(expected, letter_x)
    items = list_mark_items(found)
    # A carrier enters once for each mark of its letters it might hold.
    carried: list[tuple[Carrier, int]] = []
    for carrier in carriers:
        own = [text for text in expected if text.letter in carrier.letters]
        carried += [(carrier, n) for n in range(max(len(own), len(carrier.fixed)))]
    count_items, count_carried, count_slots = len(items), len(carried), len(slots)
    rows = count_items + count_carried
    size = rows + count_slots
    result = WordCheck()
    if not size:
        return result
    # Square: items and slots; each item may stay out (its own column), each slot
    # may stay empty (its own row), and an empty slot meeting an unused item costs 0.
    cost = [[IMPOSSIBLE] * size for _ in range(size)]
    for i, (mark, fixed) in enumerate(items):
        for j, slot in enumerate(slots):
            alone = prices[slot.mark].alone if slot.mark in prices and slot.first else 0.0
            cost[i][j] = price_item_in_slot(mark, fixed, slot, width) + alone
        cost[i][count_slots + i] = price_left_over(mark, fixed)
    for k, (carrier, n) in enumerate(carried):
        i = count_items + k
        for j, slot in enumerate(slots):
            inside = prices[slot.mark].inside if slot.mark in prices else 0.0
            price = price_carrier_in_slot(carrier, slot, expected)
            cost[i][j] = price + inside if price < IMPOSSIBLE else IMPOSSIBLE
        # Holding nothing costs the body's own preference once; a mark it was told to
        # hold is never left out.
        cost[i][count_slots + i] = IMPOSSIBLE if n < len(carrier.fixed) else (carrier.plain if n == 0 else 0.0)
    for j, slot in enumerate(slots):
        cost[rows + j][j] = price_missing_slot(slot, prices)
        for k in range(rows):
            cost[rows + j][count_slots + k] = 0.0
    chosen = assign_least_cost(cost)
    result.cost = sum(cost[i][chosen[i]] for i in range(size) if cost[i][chosen[i]] < IMPOSSIBLE)

    matched: dict[int, list[tuple[str, MarkSlot]]] = {}
    filled: set[int] = set()
    left_over: list[tuple[FoundMark, str]] = []
    for i, (mark, fixed) in enumerate(items):
        j = chosen[i]
        if j < count_slots and cost[i][j] < IMPOSSIBLE:
            matched.setdefault(mark.id, []).append((fixed, slots[j]))
            filled.add(j)
        else:
            left_over.append((mark, fixed))
    for k, (carrier, _) in enumerate(carried):
        j = chosen[count_items + k]
        if j < count_slots and cost[count_items + k][j] < IMPOSSIBLE:
            result.inside.setdefault(carrier.id, []).append(expected[slots[j].mark].kind)
            filled.add(j)
    for ident, kinds in result.inside.items():
        result.inside[ident] = parts_of(compound(*kinds))
    by_id = {mark.id: mark for mark in found}
    for ident, placed in matched.items():
        mark = by_id[ident]
        names = [name_type_in_slot(mark, fixed, slot, expected) for fixed, slot in placed]
        result.types[ident] = names[0] if len(names) == 1 else compound(*names)
        if any(expected[slot.mark].kind == "tanween" for _, slot in placed) and result.types[ident] != "tanween":
            result.tanween.add(ident)
        if mark.typed and mark.typed != result.types[ident]:
            result.disagree.append(ident)
    extra = {mark.id for mark, fixed in left_over if (fixed or mark.likeliest) not in PAUSE_KINDS}
    result.extra = sorted(extra - set(matched))
    missing = sorted({slots[j].mark for j in range(count_slots) if slots[j].required and j not in filled})
    result.missing = [expected[index] for index in missing]
    join_missing_mark_into_neighbour(result, expected, matched, by_id)
    if result.clean:
        for ident in result.types:
            mark = by_id[ident]
            if mark.typed or does_shape_agree(mark, result.types[ident]):
                result.sure.add(ident)
    return result


def name_type_in_slot(mark: FoundMark, fixed: str, slot: MarkSlot, expected: list[TextMark]) -> str:
    """The type a slot gives the ink in it."""
    if fixed:
        return fixed
    text = expected[slot.mark]
    if text.kind == "tanween":
        shape = mark.typed or mark.likeliest
        if shape in slot.kinds:
            return shape
        # Untyped: the slot's type it looks most like.
        return min(slot.kinds, key=lambda kind: (mark.scores.get(kind, 1.0), kind))
    if text.kind == "waqfMuanaqa":
        return "waqfMuanaqa"
    return text.kind


def does_shape_agree(mark: FoundMark, kind: str) -> bool:
    """Whether the matcher does not prefer another type by much. A type it has never
    seen is the text's to name."""
    if not mark.scores:
        return True
    score = mark.scores.get(kind)
    if score is None:
        known = [mark.scores[part] for part in parts_of(kind) if part in mark.scores]
        if not known:
            return True
        score = min(known)
    return score - min(mark.scores.values()) <= SURE_MARGIN


def join_missing_mark_into_neighbour(
    result: WordCheck,
    expected: list[TextMark],
    matched: dict[int, list[tuple[str, MarkSlot]]],
    by_id: dict[int, FoundMark],
) -> None:
    """A missing mark whose neighbour's ink looks like the two printed as one: that ink
    is both. Only a pair the matcher has examples of — a hamza and its kasra under an
    alef, typed so on some page — and only for untyped ink."""
    for text in list(result.missing):
        for ident, placed in matched.items():
            mark = by_id[ident]
            if mark.typed or len(placed) != 1:
                continue
            slot = placed[0][1]
            other = expected[slot.mark]
            if other.letter != text.letter or other.lane != text.lane:
                continue
            pair = compound(result.types[ident], text.kind)
            single = mark.scores.get(result.types[ident])
            joined = mark.scores.get(pair)
            if joined is not None and (single is None or joined <= single + 0.05):
                result.types[ident] = pair
                result.missing.remove(text)
                break


def assign_least_cost(cost: list[list[float]]) -> list[int]:
    """The column each row takes in a least-cost assignment of a square matrix: the
    Hungarian method, with potentials."""
    size = len(cost)
    infinity = float("inf")
    u = [0.0] * (size + 1)
    v = [0.0] * (size + 1)
    owner = [0] * (size + 1)
    way = [0] * (size + 1)
    for row in range(1, size + 1):
        owner[0] = row
        column = 0
        least = [infinity] * (size + 1)
        used = [False] * (size + 1)
        while True:
            used[column] = True
            current = owner[column]
            delta = infinity
            step = 0
            for j in range(1, size + 1):
                if used[j]:
                    continue
                reduced = cost[current - 1][j - 1] - u[current] - v[j]
                if reduced < least[j]:
                    least[j] = reduced
                    way[j] = column
                if least[j] < delta:
                    delta = least[j]
                    step = j
            for j in range(size + 1):
                if used[j]:
                    u[owner[j]] += delta
                    v[j] -= delta
                else:
                    least[j] -= delta
            column = step
            if owner[column] == 0:
                break
        while column:
            previous = way[column]
            owner[column] = owner[previous]
            column = previous
    chosen = [-1] * size
    for j in range(1, size + 1):
        if owner[j]:
            chosen[owner[j] - 1] = j - 1
    return chosen

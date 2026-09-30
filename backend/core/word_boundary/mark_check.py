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

A slot left empty costs nothing when its mark may leave no ink of its own (the hamza
drawn inside its alef), and ``MISSING`` otherwise; ink left over costs ``EXTRA``, a
pause sign much less (readings pause in different places). A mark may come in pieces —
a tanween's two strokes, a dot group's dots, the three dots of the embraced pause — and
each piece is a slot, the first required and the rest free. One blob may be two marks
touching — a hamza and its kasra — when it is typed so, or looks most like such a pair:
it then takes two slots.

Pure: plain data in, plain data out. The Hungarian method solves each word exactly; a
word has a few dozen slots at most.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from core.text.marks import Lane, TextMark

#: Pause signs: a reading's, not the text's alone, so never counted against a word.
PAUSE_KINDS = frozenset({"waqfSili", "waqfQili", "waqfJim", "waqfMim", "waqfLa", "waqfMuanaqa"})
#: The order a fused pair's names are written in — "hamza+kasra", never "kasra+hamza".
COMPOUND_ORDER = (
    "hamza",
    "wasla",
    "madda",
    "daggerAlif",
    "shadda",
    "fatha",
    "damma",
    "kasra",
    "sukun",
    "roundZero",
    "rectZero",
    "tanween",
    "smallLetter",
    "ijamDot",
    "waqfSili",
    "waqfQili",
    "waqfJim",
    "waqfMim",
    "waqfLa",
    "waqfMuanaqa",
    "other",
)

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


def compound(*parts: str) -> str:
    """The name of marks printed as one blob, their parts in one fixed order."""
    rank = {name: index for index, name in enumerate(COMPOUND_ORDER)}
    return "+".join(sorted(parts, key=lambda part: (rank.get(part, len(rank)), part)))


def parts_of(kind: str) -> list[str]:
    """A type's parts: one for a single mark, two or more for marks printed as one."""
    return kind.split("+") if kind else []


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


@dataclass
class WordCheck:
    """What the text makes of one word's marks."""

    #: Blob id → the type the text names for it.
    types: dict[int, str] = field(default_factory=dict)
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

    @property
    def clean(self) -> bool:
        return not self.missing and not self.extra and not self.disagree


@dataclass(frozen=True)
class _Slot:
    mark: int
    kinds: frozenset[str]
    required: bool
    x: float
    lane: Lane
    #: A pause sign sits over the word's end, or the gap after it: where it lies within
    #: the word says nothing.
    anywhere: bool = False


def _slots(expected: list[TextMark], letter_x: list[float]) -> list[_Slot]:
    slots: list[_Slot] = []
    for index, mark in enumerate(expected):
        x = letter_x[min(max(mark.letter, 0), len(letter_x) - 1)] if letter_x else 0.0
        if mark.kind == "tanween":
            # A joined pair is one blob of its own shape; apart, each stroke is its
            # vowel's — the dammatan's second one a curl of its own.
            accepted = [frozenset({"tanween", mark.base}), frozenset({mark.base, "other"})]
        elif mark.kind == "waqfMuanaqa":
            accepted = [frozenset({"waqfMuanaqa", "ijamDot"})] * mark.pieces
        else:
            accepted = [frozenset({mark.kind})] * mark.pieces
        anywhere = mark.kind in PAUSE_KINDS
        for piece, kinds in enumerate(accepted):
            slots.append(_Slot(index, kinds, piece == 0 and not mark.optional, x, mark.lane, anywhere))
    return slots


def _items(found: list[FoundMark]) -> list[tuple[FoundMark, str]]:
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


def _shape(mark: FoundMark, fixed: str, kinds: frozenset[str]) -> float:
    kind = fixed or mark.typed
    if kind:
        # Typed as another type: a slip of the hand, or an old name, when the ink
        # looks like the slot's type — another mark altogether when it does not.
        return 0.0 if kind in kinds else DISAGREE + _likeness(mark, kinds)
    if mark.hint:
        return 0.0 if mark.hint in kinds else DISAGREE
    return _likeness(mark, kinds)


def _likeness(mark: FoundMark, kinds: frozenset[str]) -> float:
    """How far the ink is from looking like the likeliest of ``kinds``, by the matcher:
    0 when one of them is what it looks most like."""
    if not mark.scores:
        return UNKNOWN
    best = min(mark.scores.values())
    return min(min(1.0, mark.scores[kind] - best) if kind in mark.scores else UNKNOWN for kind in kinds)


def _cost(mark: FoundMark, fixed: str, slot: _Slot, width: float) -> float:
    if mark.lane == slot.lane:
        lane = 0.0
    elif "line" in (mark.lane, slot.lane):
        lane = LINE_LANE
    else:
        return IMPOSSIBLE
    position = 0.0 if slot.anywhere else W_POSITION * abs(mark.x - slot.x) / max(width, 1.0)
    return lane + position + _shape(mark, fixed, slot.kinds)


def _extra(mark: FoundMark, fixed: str) -> float:
    return EXTRA_PAUSE if (fixed or mark.likeliest) in PAUSE_KINDS else EXTRA


def check_word(
    expected: list[TextMark],
    letter_x: list[float],
    width: float,
    found: list[FoundMark],
) -> WordCheck:
    """Match one word's ink marks to its text's marks — see the module docstring.

    ``letter_x`` is where each letter of the word's skeleton sits (``letters_of``
    order), and ``width`` the word's width, in the units of ``FoundMark.x``.
    """
    slots = _slots(expected, letter_x)
    items = _items(found)
    count_items, count_slots = len(items), len(slots)
    size = count_items + count_slots
    result = WordCheck()
    if not size:
        return result
    # Square: items and slots; each item may stay out (its own column), each slot
    # may stay empty (its own row), and an empty slot meeting an unused item costs 0.
    cost = [[IMPOSSIBLE] * size for _ in range(size)]
    for i, (mark, fixed) in enumerate(items):
        for j, slot in enumerate(slots):
            cost[i][j] = _cost(mark, fixed, slot, width)
        cost[i][count_slots + i] = _extra(mark, fixed)
    for j, slot in enumerate(slots):
        cost[count_items + j][j] = MISSING if slot.required else 0.0
        for k in range(count_items):
            cost[count_items + j][count_slots + k] = 0.0
    chosen = _assign(cost)

    matched: dict[int, list[tuple[str, _Slot]]] = {}
    filled: set[int] = set()
    left_over: list[tuple[FoundMark, str]] = []
    for i, (mark, fixed) in enumerate(items):
        j = chosen[i]
        if j < count_slots and cost[i][j] < IMPOSSIBLE:
            matched.setdefault(mark.id, []).append((fixed, slots[j]))
            filled.add(j)
        else:
            left_over.append((mark, fixed))
    by_id = {mark.id: mark for mark in found}
    for ident, placed in matched.items():
        mark = by_id[ident]
        names = [_named(mark, fixed, slot, expected) for fixed, slot in placed]
        result.types[ident] = names[0] if len(names) == 1 else compound(*names)
        if any(expected[slot.mark].kind == "tanween" for _, slot in placed) and result.types[ident] != "tanween":
            result.tanween.add(ident)
        if mark.typed and mark.typed != result.types[ident]:
            result.disagree.append(ident)
    extra = {mark.id for mark, fixed in left_over if (fixed or mark.likeliest) not in PAUSE_KINDS}
    result.extra = sorted(extra - set(matched))
    missing = sorted({slots[j].mark for j in range(count_slots) if slots[j].required and j not in filled})
    result.missing = [expected[index] for index in missing]
    _fuse_missing(result, expected, slots, matched, by_id)
    if result.clean:
        for ident in result.types:
            mark = by_id[ident]
            if mark.typed or _agrees(mark, result.types[ident]):
                result.sure.add(ident)
    return result


def _named(mark: FoundMark, fixed: str, slot: _Slot, expected: list[TextMark]) -> str:
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


def _agrees(mark: FoundMark, kind: str) -> bool:
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


def _fuse_missing(
    result: WordCheck,
    expected: list[TextMark],
    slots: list[_Slot],
    matched: dict[int, list[tuple[str, _Slot]]],
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


def _assign(cost: list[list[float]]) -> list[int]:
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

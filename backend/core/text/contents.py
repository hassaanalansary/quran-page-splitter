"""What one blob of ink holds, as one short key: ``bodies:marks``.

Pure text, like :mod:`core.text.arabic`: no Django, no numpy.

Every blob of a text line is some letters, some marks, or both printed touching. The
key says which, in one grammar for every case — a plain letter, a mark, a letter with
its mark touching, two pieces printed as one::

    سو:            a body of one piece, nothing touching it
    :fatha         a mark alone
    ا:roundZero    an alef with its round zero touching it
    أ:             an alef whose hamza is printed apart (a mark blob of its own)
    إ+لا:          إلا's two pieces printed touching, as one body
    ت:ijamDot      a tooth whose dots touch it

The rules:

* **Bodies**, before the ``:``, are pieces of Arabic words, one element per piece in
  reading order, spelled as the text spells them. How many there are is how many
  pieces the blob counts for.
* **Marks**, after the ``:``, are named only when they touch the blob's ink. They
  are written in :data:`COMPOUND_ORDER`, so one set of marks has one key.
* ``+`` separates the elements of a group.
* ``?`` is an **open** element: something is there, nobody has said what. A lone
  ``?`` in the bodies is a body of one *or more* pieces; ``?+?`` is exactly two.
* ``*`` is an **undecided** group: nobody has said whether anything is there at all.
  ``أ:*`` is an alef whose touching marks nobody looked at; ``""`` is nothing decided.

A person's decision may be partial (``?``, ``*``); the engine's reading is complete
where the text lets it be. :func:`fill_open_parts` lays one over the other.

The browser never splits these strings — mixed right-to-left letters and left-to-right
names display scrambled, and two parsers would drift. It gets the *parts*
(:func:`describe_contents_parts`) and sends parts back (:func:`read_parts_into_key`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from core.text.arabic import letters_of, paws

#: Separates a key's bodies from its marks.
GROUP_SEPARATOR = ":"
#: Separates the elements of one group.
PART_SEPARATOR = "+"
#: An element that is there, but nobody has said what it is.
OPEN = "?"
#: A group nobody has decided on: anything, or nothing, may be there.
UNDECIDED = "*"

#: The order marks printed as one blob are written in — "hamza+kasra", never
#: "kasra+hamza". A mark not listed sorts after these, by name.
COMPOUND_ORDER = (
    "hamza",
    "kafCurl",
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
    "smallWaw",
    "smallYa",
    "smallMeem",
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

#: A mark's name: an identifier, so the list can grow with the mushafs (a new sign is
#: a new name, never a new grammar).
MARK_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")

#: An element of a group: a name or a piece, or ``None`` for ``?``.
Element = str | None
#: A group: its elements, or ``None`` when it is undecided (``*``).
Group = tuple[Element, ...] | None


class ContentsKeyError(ValueError):
    """A key, or its parts, that the grammar does not allow."""


@dataclass(frozen=True)
class ContentsKey:
    """A parsed key. ``bodies`` and ``marks`` are ``None`` when undecided; inside them,
    ``None`` is an open element."""

    bodies: Group = None
    marks: Group = None


#: Nothing decided at all — what a blob nobody touched has.
NOTHING_DECIDED = ContentsKey()


def compound(*parts: str) -> str:
    """The name of marks printed as one blob, their parts in one fixed order."""
    return PART_SEPARATOR.join(sort_mark_names(parts))


def parts_of(kind: str) -> list[str]:
    """A type's parts: one for a single mark, two or more for marks printed as one."""
    return kind.split(PART_SEPARATOR) if kind else []


def sort_mark_names(names: tuple[str, ...] | list[str]) -> list[str]:
    """Mark names in :data:`COMPOUND_ORDER`, unknown ones after, by name."""
    rank = {name: index for index, name in enumerate(COMPOUND_ORDER)}
    return sorted(names, key=lambda name: (rank.get(name, len(rank)), name))


def is_paw(text: str) -> bool:
    """Whether ``text`` is exactly one piece of an Arabic word, letters only."""
    return bool(text) and letters_of(text) == text and paws(text) == [text]


def check_body(element: str) -> str:
    if not is_paw(element):
        raise ContentsKeyError(f"{element!r} is not one piece of a word")
    return element


def check_mark(element: str) -> str:
    if not MARK_NAME.match(element):
        raise ContentsKeyError(f"{element!r} is not a mark name")
    return element


def parse_group(text: str, kind: Literal["bodies", "marks"]) -> Group:
    if text == UNDECIDED:
        return None
    if text == "":
        return ()
    check = check_body if kind == "bodies" else check_mark
    elements: list[Element] = []
    for element in text.split(PART_SEPARATOR):
        if element == OPEN:
            elements.append(None)
        elif element in ("", UNDECIDED):
            raise ContentsKeyError(f"an empty or undecided element inside {text!r}")
        else:
            elements.append(check(element))
    return tuple(elements)


def parse_contents_key(text: str) -> ContentsKey:
    """The key ``text`` as parts. ``""`` is nothing decided. Raises
    :class:`ContentsKeyError` for anything the grammar does not allow."""
    if text == "":
        return NOTHING_DECIDED
    if text.count(GROUP_SEPARATOR) != 1:
        raise ContentsKeyError(f"{text!r} needs exactly one {GROUP_SEPARATOR!r}")
    bodies, marks = text.split(GROUP_SEPARATOR)
    return order_marks(ContentsKey(parse_group(bodies, "bodies"), parse_group(marks, "marks")))


def format_group(group: Group) -> str:
    if group is None:
        return UNDECIDED
    return PART_SEPARATOR.join(OPEN if element is None else element for element in group)


def format_contents_key(key: ContentsKey) -> str:
    """The one string for ``key``: marks in :data:`COMPOUND_ORDER`, open marks last;
    ``""`` when nothing is decided."""
    if key == NOTHING_DECIDED:
        return ""
    key = order_marks(key)
    return f"{format_group(key.bodies)}{GROUP_SEPARATOR}{format_group(key.marks)}"


def order_marks(key: ContentsKey) -> ContentsKey:
    if not key.marks:
        return key
    named = sort_mark_names([mark for mark in key.marks if mark is not None])
    open_count = sum(mark is None for mark in key.marks)
    return ContentsKey(key.bodies, (*named, *([None] * open_count)))


def describe_contents_parts(key: ContentsKey) -> dict[str, list[Element] | None]:
    """What the API sends for a key: each group as a list, ``null`` for an open
    element, the whole group ``null`` when undecided."""
    key = order_marks(key)
    return {
        "paws": None if key.bodies is None else list(key.bodies),
        "marks": None if key.marks is None else list(key.marks),
    }


def read_parts_into_key(parts: object) -> ContentsKey:
    """The key the client's parts describe — validated, never trusted. ``None`` is
    nothing decided. Raises :class:`ContentsKeyError`."""
    if parts is None:
        return NOTHING_DECIDED
    if not isinstance(parts, dict) or set(parts) - {"paws", "marks"}:
        raise ContentsKeyError("parts must be an object with paws and marks")
    groups: list[Group] = []
    for name, check in (("paws", check_body), ("marks", check_mark)):
        value = parts.get(name)
        if value is None:
            groups.append(None)
            continue
        if not isinstance(value, list):
            raise ContentsKeyError(f"{name} must be a list or null")
        elements: list[Element] = []
        for element in value:
            if element is None:
                elements.append(None)
            elif isinstance(element, str):
                elements.append(check(element))
            else:
                raise ContentsKeyError(f"{name} holds {element!r}")
        groups.append(tuple(elements))
    return order_marks(ContentsKey(groups[0], groups[1]))


def fill_group(decided: Group, reading: Group) -> Group:
    if decided is None:
        return reading
    if reading is None or None not in decided:
        return decided
    if decided == (None,):
        # One or more, open: whatever the reading found, if it found any.
        return reading if reading else decided
    if len(reading) != len(decided):
        return decided
    return tuple(said if said is not None else read for said, read in zip(decided, reading, strict=True))


def fill_open_parts(decided: ContentsKey, reading: ContentsKey) -> ContentsKey:
    """``decided`` with its open and undecided parts taken from ``reading``. What a
    person decided is never replaced; an open element only where the reading has the
    same number of elements in that group."""
    return order_marks(
        ContentsKey(fill_group(decided.bodies, reading.bodies), fill_group(decided.marks, reading.marks))
    )


def count_key_paws(key: ContentsKey) -> int | None:
    """How many pieces the blob counts for; ``None`` when that is open (a lone ``?``
    or undecided bodies)."""
    if key.bodies is None or key.bodies == (None,):
        return None
    return len(key.bodies)


def find_role_of_key(key: ContentsKey) -> Literal["body", "mark"] | None:
    """``body`` when the blob holds letters, ``mark`` when it holds marks and no
    letters; ``None`` when neither is decided."""
    if key.bodies:
        return "body"
    if key.bodies == () and key.marks:
        return "mark"
    return None


def is_key_complete(key: ContentsKey) -> bool:
    """Whether every group is decided and has no open element."""
    return all(group is not None and None not in group for group in (key.bodies, key.marks))


def find_letters_of_key(key: ContentsKey) -> str:
    """The key's letters run together, the open ones left out."""
    return "".join(body for body in key.bodies or () if body is not None)

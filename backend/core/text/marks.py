"""What a word's text says its marks are — the other half of what a spelling predicts.

``arabic.paws`` counts the letter bodies a word must print; this lists everything else
its text names, letter by letter: every haraka, tanween, shadda, sukun and madda, the
small letters, the hamza a letter carries, the i'jam dot groups — and, from a text that
has them, the pause sign after the word. Pure text, like ``arabic``: no pixels.

Each mark comes with where it is drawn — above the writing line, below it, or *on* it,
as the small waw and ya are (``بِهِۦ``, ``لَهُۥ``) — and with how it may be printed:

* **optional** marks may leave no ink of their own. The hamza of ``أ`` is often drawn
  touching its alef, and the wasla of ``ٱ`` joined to it; a final ``ك`` carries a small
  mark inside it in the Madinah hand and none in others; a pause sign depends on the
  reading. The text says they *may* be there, never that they must.
* **pieces** says how many separate blobs one mark may come in: a tanween is two strokes
  that may or may not touch (on the first mushaf's pages, a staggered fathatan was one
  blob 15 times and two strokes 23 times), a dot group is up to three dots, and the
  embraced pause sign ``ۛ`` is three.

A tanween followed by a small meem (iqlab) is printed as *one* vowel stroke and the
meem, so it is listed as that vowel.

The kinds are the types the calibration editor gives marks, so the two sides compare
directly. The upright rectangular zero ``۠`` is its own kind, and so is the round zero
``۟``: a letter written and never read, a different sign from sukun though the two
look alike in some prints.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from core.text.arabic import IJAM, MARKS

Lane = Literal["above", "below", "line"]

#: A mark carried by its own code point, after its letter.
_COMBINING: dict[str, tuple[str, Lane]] = {
    "\u064e": ("fatha", "above"),
    "\u064f": ("damma", "above"),
    "\u0650": ("kasra", "below"),
    "\u0652": ("sukun", "above"),
    "\u0651": ("shadda", "above"),
    "\u0653": ("madda", "above"),
    "\u0670": ("daggerAlif", "above"),
    "\u0654": ("hamza", "above"),
    "\u0655": ("hamza", "below"),
    "\u06df": ("roundZero", "above"),
    "\u06e0": ("rectZero", "above"),
    "\u06e5": ("smallLetter", "line"),  # small waw, nearly always after a word-final heh
    "\u06e6": ("smallLetter", "line"),  # small ya, likewise
    "\u06e7": ("smallLetter", "above"),  # small high ya
    "\u06e2": ("smallLetter", "above"),  # small high meem: iqlab
    "\u06ed": ("smallLetter", "below"),  # small low meem: iqlab under a kasratan
    "\u06e8": ("smallLetter", "above"),  # small high noon
    "\u06dc": ("smallLetter", "above"),  # small high seen
    "\u06e3": ("smallLetter", "below"),  # small low seen
    # Other editions' spellings of the same signs.
    "\u06e1": ("sukun", "above"),  # small high dotless head of khah
    "\u06e4": ("madda", "above"),  # small high madda
}
#: Tanween, and the vowel whose two strokes make it.
_TANWEEN: dict[str, tuple[str, Lane]] = {
    "\u064b": ("fatha", "above"),
    "\u064c": ("damma", "above"),
    "\u064d": ("kasra", "below"),
}
#: The small meems that turn a tanween into one vowel stroke and a meem.
_IQLAB = frozenset("\u06e2\u06ed")
#: Letters whose mark is part of their code point, and whether it may be inside them.
_CARRIED: dict[str, tuple[str, Lane, bool]] = {
    "أ": ("hamza", "above", True),
    "ؤ": ("hamza", "above", True),
    "ئ": ("hamza", "above", True),
    "إ": ("hamza", "below", False),  # below its alef, never inside it — with its kasra, often one blob
    "آ": ("madda", "above", False),
    "ٱ": ("wasla", "above", True),
}
#: Pause signs, as a text with them writes them after a word.
PAUSES: dict[str, str] = {
    "\u06d6": "waqfSili",
    "\u06d7": "waqfQili",
    "\u06d8": "waqfMim",
    "\u06d9": "waqfLa",
    "\u06da": "waqfJim",
    "\u06db": "waqfMuanaqa",
}
#: Annotation signs a reader needs and this list has no kind for: the imala, ishmam and
#: tas-hil marks of a handful of words. Expected, never required.
_LOW_OTHERS = frozenset("\u06ea")


@dataclass(frozen=True)
class TextMark:
    """One mark a word's text names."""

    #: The type the calibration editor calls it.
    kind: str
    lane: Lane
    #: Its letter, as an index into ``letters_of(word)``.
    letter: int
    #: May leave no ink of its own — see the module docstring.
    optional: bool = False
    #: How many separate blobs it may be printed in.
    pieces: int = 1
    #: A tanween's vowel.
    base: str = ""


def text_marks(word: str, *, pause: str = "", ijam: bool = True) -> list[TextMark]:
    """Every mark ``word``'s text names, in the order of its letters.

    ``pause`` is the pause sign written after the word by a text that has them (``""``
    for none). ``ijam`` false makes the dot groups optional: a mushaf whose script
    does not follow the dotting table (see ``arabic.IJAM``) still has its dots
    *typed* by the text where they are, but is never short of one.
    """
    found: list[TextMark] = []
    letter = -1
    chars = list(word)
    for index, ch in enumerate(chars):
        if ch not in MARKS:
            letter += 1
            carried = _CARRIED.get(ch)
            if carried is not None:
                kind, lane, optional = carried
                found.append(TextMark(kind, lane, letter, optional=optional))
            dots = IJAM.get(ch)
            if dots is not None:
                for count, lane in ((dots[0], "above"), (dots[1], "below")):
                    if count:
                        found.append(TextMark("ijamDot", lane, letter, optional=not ijam, pieces=count))
            continue
        at = max(letter, 0)
        if ch in _TANWEEN:
            base, lane = _TANWEEN[ch]
            # The meem may come after the letter's other marks: ``صُمٌّۢ`` is
            # tanween, shadda, meem.
            following = ""
            for later in chars[index + 1 :]:
                if later not in MARKS:
                    break
                if later in _IQLAB:
                    following = later
                    break
            if following:
                found.append(TextMark(base, lane, at))
            else:
                found.append(TextMark("tanween", lane, at, pieces=2, base=base))
        elif ch in _COMBINING:
            kind, lane = _COMBINING[ch]
            found.append(TextMark(kind, lane, at))
        elif ch in PAUSES:
            found.append(_pause(ch, at))
        elif ch in _LOW_OTHERS:
            found.append(TextMark("other", "below", at, optional=True))
        elif "\u06d6" <= ch <= "\u06ed" or "\u0610" <= ch <= "\u061a" or "\u0656" <= ch <= "\u065f":
            found.append(TextMark("other", "above", at, optional=True))
        # the tatweel, and anything else in MARKS, draws nothing of its own
    last = max(letter, 0)
    if letter >= 0 and _final_kaf(word):
        # The Madinah hand writes a small mark inside a final kaf; others do not.
        found.append(TextMark("hamza", "above", last, optional=True))
    for ch in pause:
        if ch in PAUSES:
            found.append(_pause(ch, last))
    return found


def _pause(ch: str, letter: int) -> TextMark:
    kind = PAUSES[ch]
    return TextMark(kind, "above", letter, optional=True, pieces=3 if kind == "waqfMuanaqa" else 1)


def _final_kaf(word: str) -> bool:
    letters = [ch for ch in word if ch not in MARKS]
    return bool(letters) and letters[-1] == "ك"


def line_marks(word: str) -> list[TextMark]:
    """The marks a word's text puts on the writing line: its small waw and ya."""
    return [mark for mark in text_marks(word) if mark.lane == "line"]

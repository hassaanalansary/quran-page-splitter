"""Read a Tanzil ``sura|aya|text`` file into ayat and words.

Pure text, like ``core.arabic``: no Django, no cv2. The ``quran`` app seeds
``Word`` and ``Aya`` from this, so the word numbering the database hands out and
the numbering the boundary builder resolves against are produced by one function.

Use the **uthmani** download. ``simple-clean`` is imlaei, gives different PAW
counts (``إصلاحها`` comes out 3 instead of 2), and ships without the ``sura|aya|``
prefix, so it cannot be indexed at all. ``uthmani`` and ``uthmani-min`` agree byte
for byte on the letters.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from core.arabic import letters_of

BASMALA_LETTERS = "بسماللهالرحمنالرحيم"

#: Every alef form folded to a bare alef, for recognising the basmala. Editions
#: disagree about which to print — uthmani writes it with wasla alef (ٱ) where
#: uthmani-minimal uses a plain one — and without folding the basmala goes
#: unrecognised and five stray words survive at the head of every sura. Safe
#: because every alef form is a non-joiner either way, so no PAW count moves.
_ALEF_FORMS = str.maketrans(dict.fromkeys("أإآٱٲٳٵ", chr(0x0627)))


@dataclass(frozen=True)
class Aya:
    sura: int
    number: int
    words: list[str]

    @property
    def key(self) -> str:
        return f"{self.sura}:{self.number}"


def load_ayat(path: Path, *, strip_basmala: bool = True) -> list[Aya]:
    """Every aya of the file, in recitation order.

    The basmala Tanzil prepends to aya 1 of every sura but 9 is removed by
    default: the mushaf prints it on a line of its own, which the pipeline
    classifies as ``is_besmella``, so counting those words as part of aya 1 would
    shift every word index in the sura. Sura 1 is left alone — there the basmala
    genuinely *is* aya 1.
    """
    ayat: list[Aya] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|", 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
            raise ValueError(
                f"{path}:{lineno}: expected 'sura|aya|text'. Use the Tanzil download that keeps the "
                f"numbering prefix — the text-only file cannot be indexed by aya."
            )
        sura, number = int(parts[0]), int(parts[1])
        words = parts[2].split()
        if strip_basmala and number == 1 and sura not in (1, 9):
            words = drop_leading_basmala(words)
        ayat.append(Aya(sura=sura, number=number, words=words))
    if not ayat:
        raise ValueError(f"{path}: no records found.")
    return ayat


def drop_leading_basmala(words: list[str]) -> list[str]:
    """Remove a basmala sitting at the *start* of an aya's word list.

    Anchored to the start on purpose: 27:30 ends with a basmala that is real
    Quranic text and has to survive. Four words, or three where the edition joins
    two of them.
    """
    for take in (4, 3):
        if len(words) > take:
            head = "".join(letters_of(w) for w in words[:take]).translate(_ALEF_FORMS)
            if head == BASMALA_LETTERS:
                return words[take:]
    return words

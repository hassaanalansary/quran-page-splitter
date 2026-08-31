"""Arabic joining and i'jam rules — what a word's spelling predicts about its ink.

Pure text: no cv2, no numpy, no Django. That is deliberate, because both sides of
the project need these answers and there must only ever be one of them.

The word-boundary engine uses them to know what ink a word *must* produce, and the
``quran`` app calls the same functions when seeding ``Word.paw_count`` — so a
stored count and a computed one can never disagree.

Arabic joining rules make the number of disconnected ink blobs a word produces
exactly predictable: letters in :data:`NON_JOINERS` never connect to what follows,
so a word breaks there and nowhere else. That makes the blob count a quantity both
the text and the image can compute, which is what turns matching words to ink into
alignment rather than recognition.
"""

from __future__ import annotations

#: Letters that never join to the letter that follows them. A word breaks after
#: each of these and nowhere else, which is what makes the blob count exact.
NON_JOINERS = frozenset("اأإآٱدذرزوؤةءٲٳٵٶٷىٮۃ")

#: Harakat, tanween, shadda, sukun, dagger alef, small Quranic letters, pause
#: marks, and the tatweel. None affect joining, so all are dropped before
#: counting. Present so the tool also accepts fully-voweled Uthmani text, not
#: just the diacritic-free "simple-clean" download.
#: Written as code points rather than literals: combining marks render on top of
#: whatever precedes them, so a literal set is unreadable and easily corrupted by
#: any tool that normalises text.
MARKS = frozenset(
    chr(c)
    for c in (
        *range(0x0610, 0x061B),  # Quranic annotation signs
        *range(0x064B, 0x0660),  # tanween, harakat, shadda, sukun, hamza seats
        0x0670,  # dagger alef
        *range(0x06D6, 0x06EE),  # small high/low letters and pause marks
        0x0640,  # tatweel: stretches a join, never breaks one
    )
)


def letters_of(word: str) -> str:
    """The joining-relevant skeleton: the word with every mark removed."""
    return "".join(ch for ch in word if ch not in MARKS)


def paws(word: str) -> list[str]:
    """Split a word into its pieces of Arabic word. Deterministic."""
    core = letters_of(word)
    pieces: list[str] = []
    current = ""
    for ch in core:
        current += ch
        if ch in NON_JOINERS:
            pieces.append(current)
            current = ""
    if current:
        pieces.append(current)
    return pieces


def paw_count(word: str) -> int:
    return max(1, len(paws(word)))


#: I'jam — the dots that distinguish one letter skeleton from another, as
#: (above, below). Unlike tashkeel these are part of letter identity: a ``ب``
#: carries one dot below in every mushaf and every qiraa, so the text predicts
#: them exactly. ``ئ`` and ``ؤ`` carry none; the hamza replaces them. Every
#: skeleton letter in the Uthmani corpus is covered, and an unlisted one
#: defaults to no dots, which simply imposes no constraint.
IJAM = {
    "ب": (0, 1), "ت": (2, 0), "ث": (3, 0), "ج": (0, 1), "خ": (1, 0),
    "ذ": (1, 0), "ز": (1, 0), "ش": (3, 0), "ض": (1, 0), "ظ": (1, 0),
    "غ": (1, 0), "ف": (1, 0), "ق": (2, 0), "ن": (1, 0), "ي": (0, 2),
    "ة": (2, 0),
}  # fmt: skip


def ijam_groups(word: str) -> tuple[int, int]:
    """How many distinct dot groups a word must carry, above and below.

    Groups, not dots: two or three dots are usually drawn as one connected
    component, so each dotted letter contributes one group regardless of how
    many dots it has. Counting raw dots would demand components that never
    exist as separate ink.
    """
    above = below = 0
    for ch in letters_of(word):
        da, db = IJAM.get(ch, (0, 0))
        above += 1 if da else 0
        below += 1 if db else 0
    return above, below

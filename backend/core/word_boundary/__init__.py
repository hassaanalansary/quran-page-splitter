"""The word-boundary engine: line images and words in, word positions out.

    from core.word_boundary import WordBoundaryInput, detect_words

    result = detect_words(WordBoundaryInput(lines=..., words=...))
    for line in result.lines:
        for word in line.words:
            ...  # word.text, word.x, word.end_x

Independent of anything that uses it. It is handed pictures rather than paths and
words rather than Arabic text, so the same engine runs from a directory of PNGs
(``script/word_lines.py``) or from the database (``api.services.word_inputs``), and
returns dataclasses either way. It opens no file, touches no database and draws
nothing.

Everything below the two contract modules is internal. ``ink``, ``separators`` and
``alignment`` are how the engine thinks, not what it promises; import from here.

**Independent** is what makes this a package of its own and the page pipeline a
single one. ``page_detection``'s stages hand each other a shared ``PageContext``,
so they are steps rather than engines; nothing here is handed anything but its own
input. Splitting a package out is worth it when a piece answers on its own — not
because it happens to be a separate concern.
"""

from core.word_boundary.engine import detect_words
from core.word_boundary.inputs import (
    IjamMode,
    LineImage,
    WordBoundaryInput,
    WordInput,
    aya_starts,
    images_from_paths,
    words_from_ayat,
)
from core.word_boundary.report import as_dict
from core.word_boundary.results import (
    FLAGGED_STATUSES,
    STATUSES,
    InkComponent,
    Ornament,
    WordBoundaryResult,
    WordBox,
    WordLine,
    WordSegment,
)

__all__ = [
    "FLAGGED_STATUSES",
    "STATUSES",
    "IjamMode",
    "InkComponent",
    "LineImage",
    "Ornament",
    "WordBoundaryInput",
    "WordBoundaryResult",
    "WordBox",
    "WordInput",
    "WordLine",
    "WordSegment",
    "as_dict",
    "aya_starts",
    "detect_words",
    "images_from_paths",
    "words_from_ayat",
]

"""Where this app's copy of the Quran text lives, and how to read it.

The reading itself is ``core.text.tanzil`` — Django-free, and shared so the word
numbering the database hands out is produced by the same code that resolves the
aya boundaries against it.

The text is vendored here rather than read from the repo's gitignored ``data/``
directory, so a fresh clone can seed. Tanzil's terms allow verbatim copies that
keep the notice, and the file carries it.

Beside it lies the same text downloaded *with* its pause signs (and the rub' el hizb
and sajda signs, the tatweel before a dagger alef, and Tanzil's marking of the
tanween forms). The words are numbered from the plain file alone; the complete one
only says which pause sign follows a word — see :func:`pause_signs`.
"""

import logging
from functools import lru_cache
from pathlib import Path

from core.text import Aya, letters_of, load_ayat, load_pauses

logger = logging.getLogger(__name__)

#: The committed Tanzil Uthmani text. Attribution: Tanzil Project, tanzil.net.
DEFAULT_QURAN_TEXT_PATH = Path(__file__).resolve().parents[1] / "data" / "quran-uthmani.txt"
#: The same text with its pause signs. Attribution: Tanzil Project, tanzil.net.
COMPLETE_QURAN_TEXT_PATH = Path(__file__).resolve().parents[1] / "data" / "quran-uthmani-complete.txt"


@lru_cache(maxsize=1)
def pause_signs() -> dict[int, str]:
    """The pause signs written after each word, by ``Word.id``; words with none are absent.

    Read from the complete text and trusted only if its words are the plain text's,
    one for one — a different edition would number them differently, and a pause
    sign on the wrong word is worse than none. Without the file, or with a mismatch,
    there are no signs: they only ever add confidence to what the ink shows.
    """
    if not COMPLETE_QURAN_TEXT_PATH.exists():
        return {}
    plain = [word for aya in load_ayat(DEFAULT_QURAN_TEXT_PATH) for word in aya.words]
    complete = load_pauses(COMPLETE_QURAN_TEXT_PATH)
    if len(complete) != len(plain) or any(
        letters_of(word) != letters_of(other) for (word, _), other in zip(complete, plain, strict=True)
    ):
        logger.warning(
            "%s does not line up with %s: pause signs ignored", COMPLETE_QURAN_TEXT_PATH, DEFAULT_QURAN_TEXT_PATH
        )
        return {}
    return {number: signs for number, (_, signs) in enumerate(complete, start=1) if signs}


__all__ = ["COMPLETE_QURAN_TEXT_PATH", "DEFAULT_QURAN_TEXT_PATH", "Aya", "load_ayat", "pause_signs"]

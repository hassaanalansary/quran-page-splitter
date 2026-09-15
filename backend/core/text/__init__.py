"""The Quran as text: its letters, its words, its suras. No pixels anywhere.

    from core.text import load_ayat, paw_count, get_sura

This is the half of the project that would still be true if no mushaf had ever been
scanned. It is also the half the ``quran`` Django app is built on — ``Word.paw_count``
and the aya boundaries are seeded from exactly these functions, which is why they
live in ``core`` rather than in the app: the word-boundary engine has to compute the
same numbers from the same rules, and two implementations would drift.

    arabic.py   joining rules — which letters break a word into pieces, and which
                carry dots. The engine's whole premise: a word's spelling predicts
                how many disconnected blobs of ink it must make.
    tanzil.py   the Tanzil corpus loader (``sura|aya|text`` lines), and the
                prepended-basmala trap that comes with it
    suras.py    the static 114-sura table: names, transliterations, aya counts

**Use ``data/quran-uthmani.txt``.** The imlaei text gives wrong PAW counts — see
``tanzil.load_ayat``, which refuses the text-only download outright.
"""

from core.text.arabic import IJAM, MARKS, NON_JOINERS, ijam_groups, letters_of, paw_count, paws
from core.text.suras import SURAS, Sura, get_aya_count, get_sura, get_sura_name, get_total_ayas
from core.text.tanzil import BASMALA_LETTERS, Aya, drop_leading_basmala, load_ayat, span

__all__ = [
    "BASMALA_LETTERS",
    "IJAM",
    "MARKS",
    "NON_JOINERS",
    "SURAS",
    "Aya",
    "Sura",
    "drop_leading_basmala",
    "get_aya_count",
    "get_sura",
    "get_sura_name",
    "get_total_ayas",
    "ijam_groups",
    "letters_of",
    "load_ayat",
    "paw_count",
    "paws",
    "span",
]

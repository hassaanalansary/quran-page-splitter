"""Where this app's copy of the Quran text lives, and how to read it.

The reading itself is ``core.quran_text`` — Django-free, and shared so the word
numbering the database hands out is produced by the same code that resolves the
aya boundaries against it.

The text is vendored here rather than read from the repo's gitignored ``data/``
directory, so a fresh clone can seed. Tanzil's terms allow verbatim copies that
keep the notice, and the file carries it.
"""

from pathlib import Path

from core.quran_text import Aya, load_ayat

#: The committed Tanzil Uthmani text. Attribution: Tanzil Project, tanzil.net.
DEFAULT_QURAN_TEXT_PATH = Path(__file__).resolve().parents[1] / "data" / "quran-uthmani.txt"

__all__ = ["DEFAULT_QURAN_TEXT_PATH", "Aya", "load_ayat"]

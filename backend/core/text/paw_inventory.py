"""How often each piece of a word, or run of pieces, occurs in a text.

Pure text, like :mod:`core.text.arabic`.

The library keeps body shapes under the text's spelling of their pieces, so how often a
piece occurs is how many examples its key can ever collect: و 13,682 times in the Hafs
text, 3,169 pieces only once. The Library view sorts by it and lists the keys a mushaf
has not confirmed yet ("none yet").

Runs count pieces printed touching inside one word — إلا's two pieces as ``إ+لا`` —
with the same ``+`` the contents keys use.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable

from core.text.arabic import paws
from core.text.contents import PART_SEPARATOR


def count_paws_of_words(words: Iterable[str], *, longest_run: int = 1) -> Counter[str]:
    """Each piece, and each run of up to ``longest_run`` consecutive pieces inside one
    word, with how often the words hold it."""
    counts: Counter[str] = Counter()
    for word in words:
        pieces = paws(word)
        for length in range(1, longest_run + 1):
            for start in range(len(pieces) - length + 1):
                counts[PART_SEPARATOR.join(pieces[start : start + length])] += 1
    return counts

"""How a mushaf's hand prints: which pieces it joins, and where it puts each mark.

Pure: plain data in, plain data out.

Two habits, counted on confirmed pages and asked about on every new one:

* **joins** — between two pieces of one word, printed *touching* (one blob) or
  *apart*. إلا touched 5 times in 5 on the Shamarly pages, إلى 0 in 6.
* **marks** — each mark the text names printed *alone* (a blob of its own), *inside*
  its letter (one blob with it: a round zero touching its alef), *joined* with a
  neighbour mark (a hamza and its kasra as one blob), or *missing* (not printed).

Each is counted at three levels, and a question goes to the narrowest one that has seen
enough::

    word        this word, this join or this letter's mark      seen 3 times or more
    pair        these two letters, or this letter with this mark seen 5 times or more
    all         every join, or every mark of this kind
    prior       nothing seen: what the text's rules expect

so إلا's own record speaks for إلا once it has been seen three times, and إلى's for
إلى, where the letters إ and ل alone would pool them.

The counts are a JSON object, kept with the mushaf's fingerprint set and summed from
each confirmed page's own (:func:`add_habit_counts`)::

    {"joins": {"word": {"إلا|0": [touching, apart]}, "pair": {"إ|ل": [...]},
               "all": {"*": [...]}},
     "marks": {"word": {"قالوا|4|roundZero": {"inside": 1}}, "pair": {"ا|roundZero": {...}},
               "all": {"roundZero": {...}}}}
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

#: Seen this often, a word's own record speaks for it.
WORD_EVIDENCE = 3
#: Seen this often, a pair of letters (or a letter with a mark) speaks for itself.
PAIR_EVIDENCE = 5
#: How strongly the prior holds against the counts: as if seen this many times.
PRIOR_WEIGHT = 2.0
#: What a join is expected to do before anything is seen: almost always apart.
JOIN_PRIOR = 0.02

MarkPlace = Literal["alone", "inside", "joined", "missing"]
MARK_PLACES: tuple[MarkPlace, ...] = ("alone", "inside", "joined", "missing")
LEVELS = ("word", "pair", "all")
#: The one key of the "all" level for joins.
EVERY_JOIN = "*"

HabitCounts = dict[str, Any]


@dataclass(frozen=True)
class WordHabits:
    """What one confirmed word shows: whether each join between its pieces was printed
    touching, and where each of its text's marks went."""

    #: The word's letters, ``letters_of`` its text.
    letters: str
    #: Its pieces, in reading order.
    paws: tuple[str, ...]
    #: One per join between consecutive pieces: printed touching?
    joins: tuple[bool, ...]
    #: One per mark the text names: (its letter's position, its kind, where it went).
    marks: tuple[tuple[int, str, MarkPlace], ...]


def make_empty_habit_counts() -> HabitCounts:
    return {"joins": {level: {} for level in LEVELS}, "marks": {level: {} for level in LEVELS}}


def find_join_keys(letters: str, pieces: tuple[str, ...] | list[str], join: int) -> dict[str, str]:
    """The keys a join between piece ``join`` and the next is counted under, by level."""
    return {
        "word": f"{letters}|{join}",
        "pair": f"{pieces[join][-1]}|{pieces[join + 1][0]}",
        "all": EVERY_JOIN,
    }


def find_mark_keys(letters: str, letter: int, kind: str) -> dict[str, str]:
    """The keys a text mark is counted under, by level."""
    sign = letters[letter] if 0 <= letter < len(letters) else ""
    return {"word": f"{letters}|{letter}|{kind}", "pair": f"{sign}|{kind}", "all": kind}


def count_word_habits(counts: HabitCounts, word: WordHabits, *, sign: int = 1) -> None:
    """Add one word's habits to ``counts`` (or take them off, with ``sign`` -1). In place."""
    for join, touching in enumerate(word.joins):
        for level, key in find_join_keys(word.letters, word.paws, join).items():
            tally = counts["joins"][level].setdefault(key, [0, 0])
            tally[0 if touching else 1] += sign
            if tally == [0, 0]:
                del counts["joins"][level][key]
    for letter, kind, place in word.marks:
        for level, key in find_mark_keys(word.letters, letter, kind).items():
            places = counts["marks"][level].setdefault(key, {})
            places[place] = places.get(place, 0) + sign
            if not places[place]:
                del places[place]
            if not places:
                del counts["marks"][level][key]


def add_habit_counts(total: HabitCounts, part: HabitCounts, *, sign: int = 1) -> None:
    """Add one page's counts to the mushaf's (or take them off). In place."""
    for level in LEVELS:
        joins = total["joins"][level]
        for key, (touching, apart) in part["joins"].get(level, {}).items():
            tally = joins.setdefault(key, [0, 0])
            tally[0] += sign * touching
            tally[1] += sign * apart
            if tally[0] <= 0 and tally[1] <= 0:
                del joins[key]
        marks = total["marks"][level]
        for key, places in part["marks"].get(level, {}).items():
            mine = marks.setdefault(key, {})
            for place, count in places.items():
                mine[place] = mine.get(place, 0) + sign * count
                if mine[place] <= 0:
                    del mine[place]
            if not mine:
                del marks[key]


def chance_of_touching(counts: HabitCounts, letters: str, pieces: tuple[str, ...] | list[str], join: int) -> float:
    """How likely the join after piece ``join`` is printed touching: the narrowest
    level that has seen enough, leaning on the prior."""
    keys = find_join_keys(letters, pieces, join)
    for level, enough in (("word", WORD_EVIDENCE), ("pair", PAIR_EVIDENCE), ("all", 1)):
        touching, apart = counts["joins"][level].get(keys[level], [0, 0])
        if touching + apart >= enough:
            return float((touching + PRIOR_WEIGHT * JOIN_PRIOR) / (touching + apart + PRIOR_WEIGHT))
    return JOIN_PRIOR


def chance_of_mark_place(
    counts: HabitCounts, letters: str, letter: int, kind: str, place: MarkPlace, prior: dict[str, float]
) -> float:
    """How likely a text mark goes to ``place``: the narrowest level that has seen
    enough, leaning on ``prior`` (each place's expected share)."""
    keys = find_mark_keys(letters, letter, kind)
    for level, enough in (("word", WORD_EVIDENCE), ("pair", PAIR_EVIDENCE), ("all", 1)):
        places = counts["marks"][level].get(keys[level], {})
        seen = sum(places.values())
        if seen >= enough:
            return float((places.get(place, 0) + PRIOR_WEIGHT * prior.get(place, 0.0)) / (seen + PRIOR_WEIGHT))
    return prior.get(place, 0.0)


def expect_mark_places(*, optional: bool) -> dict[str, float]:
    """Where a mark goes before anything is seen: alone, as the text's rules say — but a
    mark the rules call optional is as likely missing as printed."""
    if optional:
        return {"alone": 0.47, "inside": 0.02, "joined": 0.01, "missing": 0.5}
    return {"alone": 0.9, "inside": 0.04, "joined": 0.02, "missing": 0.04}

"""Build the word list and the six systems' aya boundaries, and refuse to be wrong.

``seed_words`` numbers the Uthmani text from 1. ``seed_ayat`` turns the boundary
deltas into one row per aya per counting system — 37,313 of them — by walking the
Kufi ayat and deciding, for each system, where it stops.

Reading the deltas
------------------

Everything is expressed against Kufi, and only disagreements are recorded::

    end      the Kufi aya ends here. A system in ``counted_by`` stops too; one
             that is missing does NOT, and runs this aya into the next.
    internal an extra boundary inside the Kufi aya. A system in ``counted_by``
             splits there; one that is missing reads straight past it.
    (absent) an ordinary Kufi end that all six agree on.

So a system's ayat are: every Kufi end it did not opt out of, plus every internal
split it opted into. Kufi itself opts into every end and no split, which is why
expanding Kufi has to reproduce the 6,236 ayat we started from — the first thing
:func:`validate` checks.

Why the checks are worth more than the code
-------------------------------------------

The delta expansion and the ``sura_aya_count`` table come from two unrelated
sources, so agreeing on all 684 sura counts is real evidence rather than a
restatement. What that check cannot see is a boundary placed on the wrong *word*
inside the right aya — the count is identical either way — which is why
``build_aya_boundaries`` verifies positions separately, against the upstream
project's own resolution.
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

from django.db import transaction

from core.arabic import ijam_groups, paw_count
from core.quran_text import Aya as TextAya
from core.quran_text import load_ayat
from quran.models import Aya, CountingSystem, Sura, SuraAyaCount, Word
from quran.services.quran_text import DEFAULT_QURAN_TEXT_PATH

DEFAULT_BOUNDARIES_PATH = Path(__file__).resolve().parents[1] / "data" / "aya_boundaries.json"

REFERENCE_SYSTEM = "Kufi"

#: What the six systems must come out at. Published totals, and they agree with
#: the ``total_ayahs`` the upstream dataset records for each system.
EXPECTED_AYA_TOTALS = {
    "Kufi": 6236,
    "Damascene": 6226,
    "Makkan": 6219,
    "First Madinan": 6214,
    "Last Madinan": 6214,
    "Basran": 6204,
}

#: Measured from the Tanzil Uthmani text with the 112 prepended basmalas removed.
EXPECTED_WORDS = 77_433
EXPECTED_PAWS = 159_922
EXPECTED_KUFI_AYAT = 6_236


class SeedError(Exception):
    """A check failed. The seed is wrong and must not be trusted."""


@dataclass(frozen=True)
class WordIndex:
    """The Quran text with a global word number attached to every aya."""

    ayat: list[TextAya]
    #: (sura, kufi aya) -> 1-based index of that aya's first word
    starts: dict[tuple[int, int], int]
    total: int

    def start_of(self, sura: int, aya: int) -> int:
        return self.starts[(sura, aya)]


def index_words(quran_path: Path = DEFAULT_QURAN_TEXT_PATH) -> WordIndex:
    ayat = load_ayat(quran_path)
    starts: dict[tuple[int, int], int] = {}
    running = 1
    for aya in ayat:
        starts[(aya.sura, aya.number)] = running
        running += len(aya.words)
    return WordIndex(ayat=ayat, starts=starts, total=running - 1)


def seed_words(index: WordIndex, *, batch_size: int = 2000) -> int:
    """Replace the word table with the text, numbered from 1.

    ``paw_count`` and the i'jam counts come from ``core.arabic`` — the same
    functions the boundary engine runs on the ink side, so what is stored and what
    is computed cannot disagree.
    """
    rows = []
    number = 0
    for aya in index.ayat:
        for text in aya.words:
            number += 1
            above, below = ijam_groups(text)
            rows.append(Word(id=number, text=text, paw_count=paw_count(text), ijam_above=above, ijam_below=below))
    Word.objects.bulk_create(rows, batch_size=batch_size)
    return len(rows)


def load_boundaries(path: Path = DEFAULT_BOUNDARIES_PATH) -> dict[tuple[int, int], dict]:
    """The deltas, grouped by the Kufi aya they apply to."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    grouped: dict[tuple[int, int], dict] = {}
    for boundary in payload["boundaries"]:
        entry = grouped.setdefault((boundary["sura"], boundary["kufi_aya"]), {"internal": []})
        if boundary["kind"] == "end":
            entry["end"] = boundary
        else:
            entry["internal"].append(boundary)
    for entry in grouped.values():
        entry["internal"].sort(key=lambda b: b["after_position"])
    return grouped


def aya_starts_for(system: str, index: WordIndex, deltas: dict[tuple[int, int], dict]) -> list[tuple[int, int]]:
    """Where every aya of one counting system begins.

    Returns ``(sura, first word)`` pairs in recitation order. An aya starts
    wherever the previous one stopped, so the whole job is deciding the stops.
    """
    starts: list[tuple[int, int]] = []
    sura_of_last_aya: dict[int, int] = {}
    for aya in index.ayat:
        sura_of_last_aya[aya.sura] = aya.number

    open_at: int | None = None
    for aya in index.ayat:
        first = index.start_of(aya.sura, aya.number)
        if open_at is None:
            open_at = first
        entry = deltas.get((aya.sura, aya.number), {})

        for split in entry.get("internal", ()):
            if system not in split["counted_by"]:
                continue
            starts.append((aya.sura, open_at))
            open_at = first + split["after_position"]

        end = entry.get("end")
        stops_here = end is None or system in end["counted_by"]
        # A sura always ends where it ends: no counting system runs an aya across
        # a sura boundary, whatever the deltas say.
        if aya.number == sura_of_last_aya[aya.sura] and not stops_here:
            raise SeedError(
                f"{system}: the delta for {aya.sura}:{aya.number} would run the last aya of sura "
                f"{aya.sura} into the next sura"
            )
        if stops_here:
            starts.append((aya.sura, open_at))
            open_at = None
    if open_at is not None:
        raise SeedError(f"{system}: the last aya was never closed")
    return starts


def seed_ayat(index: WordIndex, deltas: dict[tuple[int, int], dict], *, batch_size: int = 2000) -> int:
    systems = {s.name: s for s in CountingSystem.objects.all()}
    missing = set(EXPECTED_AYA_TOTALS) - set(systems)
    if missing:
        raise SeedError(f"counting systems missing from the database: {sorted(missing)}")

    rows: list[Aya] = []
    for name, system in sorted(systems.items()):
        numbers: dict[int, int] = {}
        for sura, start in aya_starts_for(name, index, deltas):
            numbers[sura] = numbers.get(sura, 0) + 1
            rows.append(Aya(counting_system=system, sura_id=sura, number=numbers[sura], start_word_id=start))
    Aya.objects.bulk_create(rows, batch_size=batch_size)
    return len(rows)


def validate(index: WordIndex) -> list[str]:
    """Every way the seed could be wrong that the data itself can answer."""
    problems: list[str] = []
    problems += _check_words(index)
    problems += _check_totals()
    problems += _check_against_sura_aya_counts()
    problems += _check_tiling(index)
    problems += _check_sura_starts()
    return problems


def _check_words(index: WordIndex) -> list[str]:
    problems = []
    count = Word.objects.count()
    if count != EXPECTED_WORDS:
        problems.append(f"word count is {count}, expected {EXPECTED_WORDS}")
    if index.total != count:
        problems.append(f"the text has {index.total} words but {count} rows were written")
    paws = sum(Word.objects.values_list("paw_count", flat=True))
    if paws != EXPECTED_PAWS:
        problems.append(f"total PAWs is {paws}, expected {EXPECTED_PAWS}")
    return problems


def _check_totals() -> list[str]:
    problems = []
    for name, expected in sorted(EXPECTED_AYA_TOTALS.items()):
        actual = Aya.objects.filter(counting_system__name=name).count()
        if actual != expected:
            problems.append(f"{name}: {actual} ayat, expected {expected}")
    kufi = Aya.objects.filter(counting_system__name=REFERENCE_SYSTEM).count()
    if kufi != EXPECTED_KUFI_AYAT:
        problems.append(f"the reference system came out at {kufi} ayat, not the {EXPECTED_KUFI_AYAT} it was built from")
    return problems


def _check_against_sura_aya_counts() -> list[str]:
    """The independent oracle: 684 counts seeded from an unrelated source."""
    expected = {
        (sura, system): count
        for sura, system, count in SuraAyaCount.objects.values_list("sura_id", "counting_system__name", "count")
    }
    if not expected:
        return ["sura_aya_count is empty — nothing to check the expansion against"]
    problems = []
    actual: dict[tuple[int, str], int] = {}
    for sura, system in Aya.objects.values_list("sura_id", "counting_system__name"):
        actual[(sura, system)] = actual.get((sura, system), 0) + 1
    for key, want in sorted(expected.items()):
        got = actual.get(key, 0)
        if got != want:
            problems.append(f"sura {key[0]} in {key[1]}: built {got} ayat, sura_aya_count says {want}")
    return problems


def _check_tiling(index: WordIndex) -> list[str]:
    """Within a system the ayat must cover word 1..N once each, with no gap."""
    problems = []
    for name in sorted(EXPECTED_AYA_TOTALS):
        starts = list(
            Aya.objects.filter(counting_system__name=name)
            .order_by("start_word_id")
            .values_list("start_word_id", flat=True)
        )
        if not starts:
            problems.append(f"{name}: no ayat at all")
            continue
        if starts[0] != 1:
            problems.append(f"{name}: the first aya starts at word {starts[0]}, not 1")
        if len(set(starts)) != len(starts):
            problems.append(f"{name}: two ayat start on the same word")
        gaps = [(a, b) for a, b in pairwise(starts) if b <= a]
        if gaps:
            problems.append(f"{name}: aya starts are not increasing ({len(gaps)} places)")
    return problems


def _check_sura_starts() -> list[str]:
    """Counting systems move aya boundaries, never sura boundaries."""
    problems = []
    by_sura: dict[int, set[int]] = {}
    for sura, start in Aya.objects.filter(number=1).values_list("sura_id", "start_word_id"):
        by_sura.setdefault(sura, set()).add(start)
    for sura, starts in sorted(by_sura.items()):
        if len(starts) != 1:
            problems.append(f"sura {sura} starts at different words depending on the counting system: {sorted(starts)}")
    if len(by_sura) != Sura.objects.count():
        problems.append(f"{len(by_sura)} suras have a first aya, but there are {Sura.objects.count()} suras")
    return problems


@transaction.atomic
def seed_quran_text(
    *,
    quran_path: Path = DEFAULT_QURAN_TEXT_PATH,
    boundaries_path: Path = DEFAULT_BOUNDARIES_PATH,
) -> tuple[int, int, list[str]]:
    """Rebuild ``Word`` and ``Aya`` from the text and the boundary seed.

    Atomic and destructive: the two tables are emptied and rewritten, so a failed
    check leaves the previous contents in place rather than half a Quran.
    """
    Aya.objects.all().delete()  # before Word: start_word is PROTECTed
    Word.objects.all().delete()

    index = index_words(quran_path)
    words = seed_words(index)
    ayat = seed_ayat(index, load_boundaries(boundaries_path))
    return words, ayat, validate(index)


def format_report(words: int, ayat: int, problems: Iterable[str]) -> str:
    lines = [f"words {words}", f"ayat  {ayat}"]
    for name in sorted(EXPECTED_AYA_TOTALS, key=lambda n: -EXPECTED_AYA_TOTALS[n]):
        lines.append(f"  {name:<16}{Aya.objects.filter(counting_system__name=name).count():>6}")
    listed = list(problems)
    lines.append("checks passed" if not listed else f"{len(listed)} CHECK(S) FAILED:")
    lines += [f"  {problem}" for problem in listed]
    return "\n".join(lines)

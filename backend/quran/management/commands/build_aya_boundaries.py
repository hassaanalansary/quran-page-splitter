"""Turn the qiraat-ayah-map primitives into the seed ``seed_quran`` reads.

A developer tool, run when the upstream dataset changes — not part of any normal
setup. It makes no network calls: it reads the two files vendored beside it and
writes a third.

What the upstream file says, and what we need
---------------------------------------------

``book-boundary-primitives.json`` records only the places where the six counting
systems *disagree*, always relative to Kufi::

    "1": {"1": {"end":      {"word": "الرحيم", "counted_by": [makki, kufi]}},
          "7": {"internal": [{"word": "عليهم", "counted_by": [madani-first, ...]}]}}

* ``end`` marks the end of a Kufi aya. A system **listed** stops there; a system
  **missing** does not, and so runs this aya together with the next one.
* ``internal`` marks an extra boundary *inside* a Kufi aya. A system listed there
  splits the aya at that word; a system not listed does not.
* Everything not mentioned is an ordinary Kufi end that all six agree on.

Boundaries are given as a *word*, never a position, so this command resolves each
one against our own Tanzil text and writes the position down.

Two kinds of boundary, two very different risks
-----------------------------------------------

An ``end`` boundary needs no searching at all: it is the end of the aya, so its
position is the aya's token count and the word is only a label. This command
verifies the label matches the last token and moves on. All 134 of them check out.

An ``internal`` boundary does need searching, and a word can occur twice in one
aya — al-Fatiha 7 has ``عليهم`` at word 4 and word 7, three words apart. The rule
upstream uses is **first occurrence**, with one recorded exception; where a word
appears only once, which is nearly always, there is nothing to get wrong.

An aya-count check cannot catch a mistake here: a split placed on the wrong
occurrence still leaves the sura with the right number of ayat. That is what
``--reference-checkout`` is for — it re-reads the positions the upstream project
resolved independently and prints every disagreement for a human to look at.
"""

import json
import unicodedata
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandParser

from core.arabic import letters_of
from quran.services.quran_text import DEFAULT_QURAN_TEXT_PATH, load_ayat

#: Their counting-system ids -> the names in our ``counting_system`` table.
SYSTEM_NAMES = {
    "kufi": "Kufi",
    "madani-first": "First Madinan",
    "madani-last": "Last Madinan",
    "makki": "Makkan",
    "basri": "Basran",
    "dimashqi": "Damascene",
}

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
PRIMITIVES_PATH = DATA_DIR / "book-boundary-primitives.json"
DEFAULT_OUTPUT_PATH = DATA_DIR / "aya_boundaries.json"

SOURCE = {
    "repo": "https://github.com/quranpedia/qiraat-ayah-map",
    "file": "data/book-boundary-primitives.json",
    "license": "MIT",
    "reference_system": "Kufi",
}

#: Where the default "first occurrence" rule is wrong. The upstream project
#: records exactly one such case in the whole Quran, and we carry it verbatim.
OCCURRENCE_OVERRIDES = {
    "7:38:internal:النار": 2,
}

# Matching a boundary word to a word of our text means matching across two
# orthographies. The dataset writes them in plain imlaei — ``الرحيم``, ``إسرائيل``,
# ``طغى`` — and our text is Uthmani: ``ٱلرَّحِيمِ``, ``إِسْرَٰٓءِيلَ``, ``طَغَىٰ``. Strip the
# marks and most pairs already meet. The two that do not are exactly the two places
# the scripts have always disagreed:
#
#   the alef    Uthmani may write it as a dagger above the line where imlaei writes
#               a letter (``عِبَٰدِى`` / ``عبادي``) — or the reverse, where imlaei
#               writes nothing at all (``ٱلرَّحْمَٰنُ`` / ``الرحمن``).
#   the hamza   Uthmani may write it as a bare mark on a stretched joint where
#               imlaei gives it a full seat letter (``ٱلْمَشْـَٔمَةِ`` / ``المشأمة``).
#
# So there is no single normal form, and guessing one direction breaks the other.
# ``forms()`` below returns three progressively looser sets instead, and a match is
# taken at the tightest level where the two words share a form. Anything settled
# below the tightest level is reported for review.

#: Every alef form written as a letter, folded to a bare alef — and the alef
#: maqsura folded to a plain yeh, which is the same skeleton with the dots put
#: back: imlaei ends ``عبادي`` where Uthmani ends ``عِبَٰدِى``. (``core.arabic`` must
#: keep them apart, because one joins to what follows and the other does not. Here
#: they are the same letter.)
_ALEF_FOLD = str.maketrans({**dict.fromkeys("أإآٱٲٳٵ", "ا"), "ى": "ي"})

#: The dagger alef, promoted to a letter *before* the marks are stripped. To
#: ``core.arabic`` it is a mark and rightly vanishes — it is no part of any ink
#: blob — but to a word search it is the letter the other spelling shows.
_DAGGER_TO_ALEF = str.maketrans({chr(0x0670): chr(0x0627)})

#: Hamza and the seats it sits on, dropped. Level two.
_DROP_HAMZA = str.maketrans(dict.fromkeys("ءئؤ", ""))

#: The alefs too. Level three, and as loose as this gets: what survives is the
#: consonantal skeleton.
_DROP_ALEF = str.maketrans(dict.fromkeys("اى", ""))

#: How a match was reached, tightest first.
MATCH_LEVELS = ("exact", "hamza-insensitive", "skeleton")

#: Their text carries the rub' el-hizb mark ۞ as a token of its own and Tanzil
#: does not, which shifts every position after it in that aya by one. Recognised
#: so the cross-check can report a real disagreement rather than that one.
_NON_WORD_TOKENS = frozenset("۞۩")


def forms(word: str) -> tuple[frozenset[str], ...]:
    """Three progressively looser spellings of one word, tightest first."""
    stripped = unicodedata.normalize("NFC", letters_of(word))
    promoted = unicodedata.normalize("NFC", letters_of(word.translate(_DAGGER_TO_ALEF)))
    # Both readings of the dagger alef — written out, and left out.
    tight = frozenset(w.translate(_ALEF_FOLD) for w in (stripped, promoted))
    hamzaless = frozenset(w.translate(_DROP_HAMZA) for w in tight)
    skeleton = frozenset(w.translate(_DROP_ALEF) for w in hamzaless)
    return tight, hamzaless, skeleton


def match_level(left: str, right: str) -> int | None:
    """The tightest level at which two spellings agree, or None if they never do."""
    for level, (a, b) in enumerate(zip(forms(left), forms(right), strict=True)):
        if a & b:
            return level
    return None


def _drop_non_words(position: int, tokens: list[str]) -> int:
    """Their position, restated in our tokenisation.

    Their token list carries the ۞ rub' mark as a word of its own. Every one of
    those standing before the boundary makes their index one larger than ours, so
    the two are only comparable once they are taken back out.
    """
    return position - sum(1 for token in tokens[:position] if token.strip() in _NON_WORD_TOKENS)


class Command(BaseCommand):
    help = "Build quran/data/aya_boundaries.json from the vendored qiraat-ayah-map primitives."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH, help="Destination JSON.")
        parser.add_argument(
            "--quran", type=Path, default=DEFAULT_QURAN_TEXT_PATH, help="Tanzil text to resolve against."
        )
        parser.add_argument(
            "--reference-checkout",
            type=Path,
            help=(
                "A checkout of quranpedia/qiraat-ayah-map (or any directory holding its "
                "site/public/generated/mushaf/surah-NNN.json files). Used only to print a "
                "disagreement report; nothing from it is written to the seed."
            ),
        )
        parser.add_argument(
            "--allow-unresolved",
            action="store_true",
            help="Write the seed even if some boundary could not be placed. Off by default.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        ayat = load_ayat(options["quran"])
        tokens = {(a.sura, a.number): a.words for a in ayat}
        primitives = json.loads(PRIMITIVES_PATH.read_text(encoding="utf-8"))

        boundaries: list[dict[str, Any]] = []
        problems: list[str] = []
        for sura_key, ayat_entries in sorted(primitives["surahs"].items(), key=lambda kv: int(kv[0])):
            sura = int(sura_key)
            for aya_key, entry in sorted(ayat_entries.items(), key=lambda kv: int(kv[0])):
                aya = int(aya_key)
                words = tokens.get((sura, aya))
                if words is None:
                    problems.append(f"{sura}:{aya} is not in the Quran text")
                    continue
                if "end" in entry:
                    boundaries.append(self._end_boundary(sura, aya, words, entry["end"], problems))
                for internal in entry.get("internal", ()):
                    resolved = self._internal_boundary(sura, aya, words, internal, problems)
                    if resolved is not None:
                        boundaries.append(resolved)

        boundaries.sort(key=lambda b: (b["sura"], b["kufi_aya"], b["after_position"]))
        self._report(boundaries, problems)

        if options["reference_checkout"]:
            self._cross_check(boundaries, options["reference_checkout"])

        if problems and not options["allow_unresolved"]:
            self.stderr.write(
                self.style.ERROR(
                    f"{len(problems)} boundary/boundaries could not be placed; nothing written. "
                    f"Fix them, or pass --allow-unresolved to write the rest anyway."
                )
            )
            return

        payload = {
            "_source": SOURCE,
            "_description": (
                "Aya boundaries where the six counting systems differ from Kufi. "
                "'after_position' is the 1-based word index within the Kufi aya, on the Tanzil "
                "Uthmani text with the prepended basmala stripped."
            ),
            "boundaries": boundaries,
        }
        output: Path = options["output"]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.stdout.write(self.style.SUCCESS(f"Wrote {len(boundaries)} boundaries -> {output}"))

    # -- the two kinds of boundary -----------------------------------------

    def _end_boundary(self, sura: int, aya: int, words: list[str], entry: dict, problems: list[str]) -> dict[str, Any]:
        """An aya's own end. The position is structural; the word only confirms it."""
        if match_level(entry["word"], words[-1]) is None:
            problems.append(
                f"{sura}:{aya} end: dataset says the aya ends on {entry['word']!r}, our text ends on {words[-1]!r}"
            )
        return {
            "sura": sura,
            "kufi_aya": aya,
            "kind": "end",
            "word": entry["word"],
            "occurrence": 1,
            "after_position": len(words),
            "counted_by": self._systems(entry["counted_by"]),
        }

    def _internal_boundary(
        self, sura: int, aya: int, words: list[str], entry: dict, problems: list[str]
    ) -> dict[str, Any] | None:
        """A split inside an aya. The only case where a word has to be found."""
        key = f"{sura}:{aya}:internal:{entry['word']}"
        # The tightest level at which anything in the aya matches, and every word
        # that matches there. Looser levels are consulted only when the tighter
        # ones find nothing at all, so a loose spelling can never outrank an exact
        # one somewhere else in the same aya.
        levels = [match_level(entry["word"], w) for w in words]
        best = min((level for level in levels if level is not None), default=None)
        if best is None:
            problems.append(f"{key}: no word in {sura}:{aya} matches (aya has {len(words)} words)")
            return None
        positions = [i for i, level in enumerate(levels, start=1) if level == best]

        occurrence = OCCURRENCE_OVERRIDES.get(key, 1)
        if occurrence > len(positions):
            problems.append(f"{key}: override asks for occurrence {occurrence} of {len(positions)}")
            return None
        boundary = {
            "sura": sura,
            "kufi_aya": aya,
            "kind": "internal",
            "word": entry["word"],
            "occurrence": occurrence,
            "after_position": positions[occurrence - 1],
            "counted_by": self._systems(entry["counted_by"]),
        }
        notes = []
        if len(positions) > 1:
            notes.append(f"{len(positions)} occurrences, took #{occurrence}")
        if best > 0:
            notes.append(f"matched {MATCH_LEVELS[best]}")
        if notes:
            boundary["review"] = ", ".join(notes)
        return boundary

    def _systems(self, ids: list[str]) -> list[str]:
        unknown = [i for i in ids if i not in SYSTEM_NAMES]
        if unknown:
            raise SystemExit(f"unknown counting system id(s) in the primitives: {unknown}")
        return [SYSTEM_NAMES[i] for i in ids]

    # -- reporting ----------------------------------------------------------

    def _report(self, boundaries: list[dict], problems: list[str]) -> None:
        ends = sum(1 for b in boundaries if b["kind"] == "end")
        internals = len(boundaries) - ends
        flagged = [b for b in boundaries if "review" in b]
        self.stdout.write(f"{len(boundaries)} boundaries: {ends} aya ends, {internals} internal splits")
        if flagged:
            self.stdout.write(self.style.WARNING(f"\n{len(flagged)} needing a human eye:"))
            for b in flagged:
                self.stdout.write(
                    f"  {b['sura']}:{b['kufi_aya']} {b['word']} -> after word {b['after_position']} ({b['review']})"
                )
        for problem in problems:
            self.stderr.write(self.style.ERROR(f"  {problem}"))

    def _cross_check(self, boundaries: list[dict], checkout: Path) -> None:
        """Compare our positions against the ones upstream resolved independently.

        Their Quran text is a different edition — Farsi yeh, different word joins —
        so a disagreement means *look*, not *wrong*.
        """
        mushaf = checkout / "site" / "public" / "generated" / "mushaf"
        if not mushaf.is_dir():
            mushaf = checkout
        theirs: dict[tuple[int, int, str, str], dict] = {}
        for path in sorted(mushaf.glob("surah-*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            tokens = {a["ayah"]: a["uthmani_tokens"] for a in data["ayahs"]}
            for key, value in data["boundary_positions"].items():
                sura_str, *_ = key.split(":")
                value = {**value, "comparable": _drop_non_words(value["uthmani_after_token"], tokens[value["ayah"]])}
                theirs[(int(sura_str), value["ayah"], value["kind"], value["word"])] = value

        agree = disagree = missing = ornament_shifted = 0
        lines: list[str] = []
        for b in boundaries:
            key = (b["sura"], b["kufi_aya"], b["kind"], b["word"])
            other = theirs.get(key)
            if other is None:
                missing += 1
                lines.append(f"  {b['sura']}:{b['kufi_aya']} {b['kind']} {b['word']}: not in their data")
                continue
            if other["comparable"] == b["after_position"]:
                agree += 1
                if other["comparable"] != other["uthmani_after_token"]:
                    ornament_shifted += 1
            else:
                disagree += 1
                lines.append(
                    f"  {b['sura']}:{b['kufi_aya']} {b['kind']} {b['word']}: "
                    f"ours {b['after_position']}, theirs {other['uthmani_after_token']} "
                    f"({other['comparable']} once their non-word tokens are dropped)"
                )
            if other.get("uthmani_resolution") == "approximate":
                lines.append(f"  {b['sura']}:{b['kufi_aya']} {b['kind']} {b['word']}: they flagged this a fuzzy match")

        self.stdout.write(f"\ncross-check: {agree} agree, {disagree} disagree, {missing} not found upstream")
        if ornament_shifted:
            self.stdout.write(
                f"  ({ornament_shifted} of the agreements needed their ۞ tokens dropped first — "
                f"their edition counts it as a word, Tanzil does not)"
            )
        style = self.style.WARNING if (disagree or missing or lines) else self.style.SUCCESS
        for line in lines:
            self.stdout.write(style(line))
        if not lines:
            self.stdout.write(self.style.SUCCESS("  every boundary matches, and none was a fuzzy match upstream"))

"""Store the boundary engine's answer: where each word sits, in page coordinates.

The engine measures in the **image's** coordinates — zero is the left edge of the
picture it was handed. Everything in the database is in **page** coordinates. The
whole job of the write path is that conversion and the rows that follow it, and the
conversion is one addition, because ``PlacedLine`` already carries the offset.

That offset cannot be worked out here. A line's image starts at that line's own left
edge, and the first and last line of a span are cut again at an aya boundary — a shift that
depends on which line is first and last *in this run*, not on anything stored about
the line. So it travels with the picture from ``services.line_images`` rather than
being rebuilt from a ``Line`` row that does not know.

Nothing here runs the engine. It is handed a result and writes it down, or handed a
human's corrections and writes those instead.
"""

import uuid
from dataclasses import dataclass, field
from itertools import pairwise

from django.db import transaction
from django.db.models import Count, Prefetch, Q

from api.models import Line, LineTypeChoices, LineWord, LineWordStatus, Page
from api.services.line_images import PlacedLine
from core.word_boundary import WordBoundaryResult
from quran.models import Aya, CountingSystem


@dataclass(frozen=True)
class SaveReport:
    """What one save did, in the terms a caller would want to show a user."""

    #: Rows removed because this run is replacing them. Only the run's own word
    #: range on its own lines — a neighbouring chunk's words are left alone.
    lines_cleared: int
    lines_written: int
    words_written: int
    #: Labels of lines the engine could not read at all. They now hold no words —
    #: visibly missing rather than quietly out of date.
    unresolved: list[str] = field(default_factory=list)
    #: Human-added cuts dropped because a word this run produced lands on the same
    #: x. Rare, and worth naming rather than crashing on.
    displaced: int = 0


@transaction.atomic
def save_word_coordinates(
    result: WordBoundaryResult,
    placements: list[PlacedLine],
    *,
    word_range: tuple[int, int],
) -> SaveReport:
    """Write every word the engine placed, converting image x to page x.

    ``placements`` is the list ``prepare_engine_input`` returned alongside the input:
    one per line, in the same order the engine received them, which is what
    ``strict=True`` below pins.

    **Cleared by word range, not by line.** A run is chunked, and consecutive chunks
    share the line an aya boundary falls on; clearing everything on that line would
    make the second chunk destroy the first one's work. Clearing this run's own word
    range leaves the neighbour's rows, and leaves rows with **no** ``word`` alone
    entirely — those are a human's additions for words the stored text does not have,
    and a re-run must not silently discard them.

    ``word_range`` is the span the engine was *asked for*, not what it managed to
    produce, and the difference matters: a line that resolved last time and did not
    this time must lose its old cuts, and deriving the range from the output would
    leave exactly those behind. Visibly missing beats quietly stale.

    ``scored`` and ``partial`` lines are stored like any other. Scored means the
    boundaries were drawn and are worth a human look; a partial line carries the words
    its resolved stretches produced. Both are answers. Only ``unresolved`` produces no
    words, and those lines are named in the report.

    Order is **stored, not measured**: position comes from the engine's own output
    order, merged with whatever survived on the line — see _place.
    """
    lines = [placed.line for placed in placements]

    rows: list[LineWord] = []
    statuses: list[LineWordStatus] = []
    unresolved: list[str] = []
    lines_written = 0

    for outcome, placed in zip(result.lines, placements, strict=True):
        status = LineWordStatus(
            line=placed.line,
            status=outcome.status,
            reason=outcome.reason or "",
            deviations=outcome.deviations,
            ties=outcome.end_sequences,
        )
        statuses.append(status)
        if not outcome.words:
            # A line with no ink parses cleanly and simply has nothing to store; a
            # line the engine could not read is a finding. Only the second is worth
            # reporting, so the caller is not handed a list of blank lines.
            if outcome.status == "unresolved":
                unresolved.append(outcome.label)
            continue
        lines_written += 1
        for box in outcome.words:
            if box.word_id is None:
                raise ValueError(
                    f"{outcome.label}: {box.text!r} carries no Word id, so there is no row to point at. "
                    f"The stream came from a text file; only a database stream "
                    f"(quran.services.words.word_stream) can be stored. A word with no label is "
                    f"something only a human correction may add."
                )
            rows.append(
                LineWord(
                    line=placed.line,
                    word_id=box.word_id,
                    # The one piece of arithmetic in this module, twice. `box.right`
                    # is the word's own right edge, measured from the same letter
                    # bodies `end_x` comes from — the engine had it all along and
                    # only the left was ever read.
                    start_x=box.right + placed.origin_x,
                    end_x=box.end_x + placed.origin_x,
                )
            )

    cleared = LineWord.objects.filter(line__in=lines, word__id__range=word_range).delete()[0]
    # A human's cut can sit exactly where this run wants to put one. Drop the
    # unlabelled one — the run found a word there, which is what the human was
    # compensating for, and two cuts on one pixel is nothing to look at.
    wanted = {(row.line_id, row.end_x) for row in rows}
    colliding = [
        row.pk
        for row in LineWord.objects.filter(line__in=lines, word__isnull=True).only("id", "line", "end_x")
        if (row.line_id, row.end_x) in wanted
    ]
    displaced = LineWord.objects.filter(pk__in=colliding).delete()[0] if colliding else 0

    _place(lines, rows)
    _write_rows(lines, rows, statuses)
    return SaveReport(
        lines_cleared=cleared,
        lines_written=lines_written,
        words_written=len(rows),
        unresolved=unresolved,
        displaced=displaced,
    )


def _place(lines: list[Line], fresh: list[LineWord]) -> None:
    """Number every word of the touched lines, survivors included, in place.

    A run clears only its **own** word range, so two kinds of row live through it: a
    neighbouring chunk's words on the line an aya boundary falls across, and a
    human's unlabelled additions. Both share the line with what this run is about to
    write, and ``unique(line, position)`` means the numbering has to be settled over
    the union rather than over the new rows alone.

    Labelled rows carry their own order — ``word.id`` is the Quran's sequence, and
    that is the whole point of storing a position rather than measuring one. An
    unlabelled row has no such key, so it is placed by its ``end_x`` among them:
    a human put that cut where they meant it, which makes its geometry the one
    trustworthy thing about it.
    """
    survivors: dict[uuid.UUID, list[LineWord]] = {}
    for row in LineWord.objects.filter(line__in=lines):
        survivors.setdefault(row.line_id, []).append(row)

    by_line: dict[uuid.UUID, list[LineWord]] = {}
    for row in fresh:
        by_line.setdefault(row.line_id, []).append(row)

    for line in lines:
        kept = survivors.get(line.pk, [])
        # Paired with the id rather than keyed on it, so the sort never has to
        # promise a type checker that a nullable column is not null here.
        labelled = [(r.word_id, r) for r in by_line.get(line.pk, []) + kept if r.word_id is not None]
        ordered = [row for _, row in sorted(labelled, key=lambda pair: pair[0])]
        for row in (r for r in kept if r.word_id is None):
            # The first labelled word ending left of this cut is the one it precedes.
            at = next((i for i, r in enumerate(ordered) if r.end_x < row.end_x), len(ordered))
            ordered.insert(at, row)
        for index, row in enumerate(ordered):
            row.position = index
        if kept:
            # Before the inserts below, so a survivor is never still sitting on a
            # slot a fresh row is about to take.
            LineWord.objects.bulk_update(kept, ["position"], batch_size=1000)


def _write_rows(lines: list[Line], rows: list[LineWord], statuses: list[LineWordStatus]) -> None:
    """Insert the words and refresh each line's status.

    Batched explicitly. Postgres does not override ``bulk_batch_size``, so Django
    would send every row in one statement, and psycopg caps a statement at 65,535
    parameters — a whole sura would break that. One sura fits at this batch size and
    a span covering several still does.
    """
    LineWord.objects.bulk_create(rows, batch_size=1000)

    # ``edited`` survives a run only where the human's own work does: an added word
    # with no label is not something the engine can reproduce, so the line is still
    # partly a person's and says so.
    human = set(LineWord.objects.filter(line__in=lines, word__isnull=True).values_list("line_id", flat=True).distinct())
    for status in statuses:
        status.edited = status.line_id in human
    LineWordStatus.objects.filter(line__in=lines).delete()
    LineWordStatus.objects.bulk_create(statuses, batch_size=1000)


# ---------------------------------------------------------------------------
# The manual fix
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CoherenceIssue:
    """One way the stored words stopped making sense as a reading of the page."""

    #: gap | overlap | outside_aya | unknown_word
    kind: str
    detail: str
    line_number: int | None = None
    words: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class PageWordsReport:
    lines_written: int
    words_written: int
    issues: list[CoherenceIssue] = field(default_factory=list)


@transaction.atomic
def replace_page_words(
    page: Page,
    line_edits: list[dict],
    *,
    counting_system: CountingSystem | None,
) -> PageWordsReport:
    """Replace the words of the named lines, whole lines at a time.

    Whole lines rather than single rows because the errors that matter move a word
    *between* lines. When the engine reads a mark as a letter it spends one word too
    many, and everything after it shifts across the line break — so the fix is "word
    108 belongs to line 11, not line 10", and both lines have to change together or
    the word is briefly on both or on neither. One call, one transaction.

    ``word_id`` may be ``None``: this mushaf's riwaya may print a word the stored text
    does not have, and the cut is the product — the label is optional.

    Each word carries **both** edges. ``start_x`` is the right one and the larger, so
    a reviewer adjusts a box rather than a pair of bare rules with nothing between
    them, and a reader can be shown the word lit from where it starts to where it
    ends. The boxes do not tile the line and may overlap; both are measured facts
    about the ink, not invariants to enforce.

    **The order words arrive in is the order they are stored in.** ``position`` is the
    array index, nothing else: the caller lists the line's words as the mushaf reads
    them and that listing *is* the edit. Nothing here re-derives a sequence from the
    geometry — a reviewer dragging a cut past its neighbour is moving where a word
    sits, never which word it is, and reordering underneath them would undo the
    correction they just made.

    Breaks are **written, not refused**. A reviewer correcting line 10 before line 11
    passes through an incoherent state deliberately, and refusing the first save would
    make the pair impossible to do one at a time. The report says what is broken; the
    same choice ``renumber_mushaf`` makes.
    """
    by_id = {str(line.id): line for line in page.lines.all()}
    touched: list[Line] = []
    rows: list[LineWord] = []
    for edit in line_edits:
        line = by_id.get(str(edit["line_id"]))
        if line is None:
            continue
        touched.append(line)
        for index, word in enumerate(edit.get("words", [])):
            rows.append(
                LineWord(
                    line=line,
                    word_id=word.get("word_id"),
                    position=index,
                    start_x=word["start_x"],
                    end_x=word["end_x"],
                )
            )

    LineWord.objects.filter(line__in=touched).delete()
    LineWord.objects.bulk_create(rows, batch_size=1000)
    LineWordStatus.objects.filter(line__in=touched).update(edited=True)

    return PageWordsReport(
        lines_written=len(touched),
        words_written=len(rows),
        issues=coherence(page, counting_system),
    )


def coherence(page: Page, counting_system: CountingSystem | None) -> list[CoherenceIssue]:
    """Everything about this page's words that no longer reads as one text.

    Reported, never enforced. Only **labelled** rows are checked: a row with no word
    has no place in the Quran's sequence and no aya of its own, so it is a correct
    state rather than a break, and counting it as a gap would flag every riwaya that
    prints a word the stored text lacks.

    Read in **stored order**, not sorted. Sorting was how this used to work, and it
    quietly repaired the one fault worth reporting: a line whose words are stored in
    the wrong sequence reads correctly once you sort it, so the check said nothing
    while the mushaf claimed an order it does not have. Out of sequence is now its own
    finding.
    """
    lines = list(
        page.lines.filter(type=LineTypeChoices.TEXT).order_by("line_number").prefetch_related("words", "segments")
    )
    issues: list[CoherenceIssue] = []
    seen: dict[int, int] = {}
    previous_last: tuple[int, int] | None = None

    for line in lines:
        # `words` comes back in position order — the model's own ordering.
        labelled = [row.word_id for row in line.words.all() if row.word_id is not None]
        if not labelled:
            continue
        if labelled != sorted(labelled):
            out_of_place = [w for w, nxt in pairwise(labelled) if w > nxt]
            issues.append(
                CoherenceIssue(
                    kind="out_of_sequence",
                    detail=(
                        f"line {line.line_number} stores its words out of the order the text reads "
                        f"them: {', '.join(str(w) for w in labelled[:12])}"
                    ),
                    line_number=line.line_number,
                    words=out_of_place[:20],
                )
            )
        for word_id in labelled:
            if word_id in seen:
                issues.append(
                    CoherenceIssue(
                        kind="overlap",
                        detail=f"word {word_id} is also on line {seen[word_id]}",
                        line_number=line.line_number,
                        words=[word_id],
                    )
                )
            seen[word_id] = line.line_number
        if previous_last is not None and labelled[0] != previous_last[1] + 1:
            missing = list(range(previous_last[1] + 1, labelled[0]))
            if missing:
                issues.append(
                    CoherenceIssue(
                        kind="gap",
                        detail=f"{len(missing)} word(s) missing after line {previous_last[0]}",
                        line_number=line.line_number,
                        words=missing[:20],
                    )
                )
        previous_last = (line.line_number, labelled[-1])

    issues += _aya_anchor_issues(lines, counting_system)
    return issues


def _aya_index(counting_system: CountingSystem, up_to_word_id: int) -> list[tuple[int, int, int]]:
    """``(start_word_id, sura, number)`` for every aya opening at or before a word.

    Sorted by ``start_word_id``, which is what ``_aya_of`` binary-searches. Bounded
    by the largest word actually on the page so a lookup for one page never loads
    the whole 6,236-row table.
    """
    return list(
        Aya.objects.filter(counting_system=counting_system, start_word_id__lte=up_to_word_id)
        .order_by("start_word_id")
        .values_list("start_word_id", "sura_id", "number")
    )


def _aya_anchor_issues(lines: list[Line], counting_system: CountingSystem | None) -> list[CoherenceIssue]:
    """Words that fell on the wrong side of the ornament closing their aya.

    An aya end is an anchor: the ornament is printed on the page and its position is
    not negotiable. A word of aya 5 must sit within the segment this line gives to
    aya 5, and a fix that pushes one past that boundary has broken the next aya. This
    is the check that catches it.
    """
    if counting_system is None:
        return []
    word_ids = [row.word_id for line in lines for row in line.words.all() if row.word_id is not None]
    if not word_ids:
        return []

    ayat = _aya_index(counting_system, max(word_ids))
    issues: list[CoherenceIssue] = []
    for line in lines:
        spans = {
            segment.aya_number: (segment.bbox_x, segment.bbox_x + segment.bbox_w)
            for segment in line.segments.all()
            if segment.aya_number is not None
        }
        if not spans:
            continue
        for row in line.words.all():
            if row.word_id is None:
                continue
            aya = _aya_of(ayat, row.word_id)
            if aya is None or aya[1] not in spans:
                continue
            left, right = spans[aya[1]]
            if not (left <= row.end_x <= right):
                issues.append(
                    CoherenceIssue(
                        kind="outside_aya",
                        detail=(
                            f"word {row.word_id} belongs to {aya[0]}:{aya[1]}, whose ink on this line "
                            f"runs x {left}..{right}, but its cut is at x {row.end_x}"
                        ),
                        line_number=line.line_number,
                        words=[row.word_id],
                    )
                )
    return issues


def _aya_of(ayat: list[tuple[int, int, int]], word_id: int) -> tuple[int, int] | None:
    """The ``(sura, number)`` of the aya holding ``word_id``, by binary search."""
    low, high = 0, len(ayat) - 1
    found = None
    while low <= high:
        mid = (low + high) // 2
        if ayat[mid][0] <= word_id:
            found = ayat[mid]
            low = mid + 1
        else:
            high = mid - 1
    return (found[1], found[2]) if found else None


def page_words(page: Page, counting_system: CountingSystem | None = None) -> list[dict]:
    """This page's lines with their words and the engine's verdict on each.

    ``text`` and ``aya`` ride along because a reviewer cannot judge a cut from an
    id: "word 2892" says nothing about whether this band holds one word or two.
    Both are for display only — the cut is still the product, and a row with no
    ``word`` carries an empty label rather than being hidden.

    ``counting_system`` is optional for the same reason ``coherence`` allows it:
    a mushaf with no riwaya set has no answer to "which aya is this", and that is
    a page worth showing anyway.
    """
    lines = list(
        page.lines.order_by("line_number")
        .prefetch_related(Prefetch("words", queryset=LineWord.objects.select_related("word")))
        .select_related("word_status")
    )

    # One index for the page, not one lookup per word: the rows come back sorted
    # and ``_aya_of`` binary-searches them.
    word_ids = [row.word_id for line in lines for row in line.words.all() if row.word_id is not None]
    ayat = _aya_index(counting_system, max(word_ids)) if counting_system and word_ids else []

    def label(row: LineWord) -> dict:
        # Through the related object rather than ``word_id``: the two agree, but
        # only this one tells a type checker the row is really there.
        word = row.word
        aya = _aya_of(ayat, word.id) if word is not None and ayat else None
        return {
            "word_id": row.word_id,
            "position": row.position,
            "start_x": row.start_x,
            "end_x": row.end_x,
            "text": word.text if word is not None else "",
            "aya": f"{aya[0]}:{aya[1]}" if aya else "",
        }

    out: list[dict] = []
    for line in lines:
        status = getattr(line, "word_status", None)
        out.append(
            {
                "line_id": line.id,
                "line_number": line.line_number,
                "status": status.status if status else None,
                "reason": status.reason if status else "",
                "deviations": status.deviations if status else 0,
                "ties": status.ties if status else 0,
                "edited": status.edited if status else False,
                # In stored order — the model orders by position, which is the
                # sequence the words table gives, not the order the cuts sit in.
                "words": [label(row) for row in line.words.all()],
            }
        )
    return out


def coverage(mushaf_id: uuid.UUID) -> list[dict]:
    """Which pages hold word data, and how much of each is still worth reviewing.

    Needs no staleness flag. Re-processing a page deletes its ``Line`` rows, which
    takes every ``LineWord`` with them by cascade, so a stale page simply reports as
    having none — which is the truth, and the reason there is nothing to invalidate.

    Sura headers and besmella lines are excluded: they carry no words, and counting
    them would make every page look permanently incomplete.
    """
    review = ("scored", "partial", "unresolved")
    rows = (
        Line.objects.filter(page__mushaf_id=mushaf_id, type=LineTypeChoices.TEXT)
        .values("page__page_number")
        .annotate(
            text_lines=Count("id", distinct=True),
            lines_with_words=Count("id", distinct=True, filter=Q(words__isnull=False)),
            # Not "words": that is the reverse accessor, and Django refuses an
            # annotation that shadows a field.
            word_count=Count("words", distinct=True),
            needs_review=Count("id", distinct=True, filter=Q(word_status__status__in=review)),
        )
        .order_by("page__page_number")
    )
    return [
        {
            "page": row["page__page_number"],
            "text_lines": row["text_lines"],
            "lines_with_words": row["lines_with_words"],
            "words": row["word_count"],
            "needs_review": row["needs_review"],
            "complete": row["text_lines"] > 0 and row["lines_with_words"] == row["text_lines"],
        }
        for row in rows
    ]


__all__ = [
    "CoherenceIssue",
    "PageWordsReport",
    "SaveReport",
    "coherence",
    "coverage",
    "page_words",
    "replace_page_words",
    "save_word_coordinates",
]

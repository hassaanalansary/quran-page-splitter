"""Store the boundary engine's answer: where each word ends, in page coordinates.

The engine measures in the **image's** coordinates — zero is the left edge of the
picture it was handed. Everything in the database is in **page** coordinates. The
whole job of this module is that conversion and the write that follows it, and the
conversion is one addition, because ``PlacedLine`` already carries the offset.

That offset cannot be worked out here. A line's image starts at the page column, and
the first and last line of a span are cut again at an aya boundary — a shift that
depends on which line is first and last *in this run*, not on anything stored about
the line. So it travels with the picture from ``services.line_images`` rather than
being rebuilt from a ``Line`` row that does not know.

Nothing here runs the engine. It is handed a result and writes it down.
"""

from dataclasses import dataclass, field

from django.db import transaction

from api.models import LineWord
from api.services.line_images import PlacedLine
from core.word_boundary import WordBoundaryResult


@dataclass(frozen=True)
class SaveReport:
    """What one save did, in the terms a caller would want to show a user."""

    #: Lines whose previous answer was removed. Every line of the run, resolved or
    #: not, because a stale reading must not survive a re-run.
    lines_cleared: int
    lines_written: int
    words_written: int
    #: Labels of lines the engine could not read at all. They now hold no words —
    #: visibly missing rather than quietly out of date.
    unresolved: list[str] = field(default_factory=list)


@transaction.atomic
def save_word_coordinates(result: WordBoundaryResult, placements: list[PlacedLine]) -> SaveReport:
    """Write every word the engine placed, converting image x to page x.

    ``placements`` is the list ``prepare_engine_input`` returned alongside the input:
    one per line, in the same order the engine received them, which is what
    ``strict=True`` below pins.

    Existing rows are cleared for **every** line in the run before anything is
    written, not only for the lines that resolved. A line the engine can no longer
    read must not keep yesterday's answer sitting beside today's — the same rule
    ``coordinates._write_engine_line`` follows when it leaves aya numbers null.

    ``scored`` and ``partial`` lines are stored like any other. Scored means the
    boundaries were drawn and are worth a human look; a partial line carries the words
    its resolved stretches produced. Both are answers. Only ``unresolved`` produces no
    words, and those lines are named in the report.
    """
    cleared = LineWord.objects.filter(line__in=[placed.line for placed in placements]).delete()[0]

    rows: list[LineWord] = []
    unresolved: list[str] = []
    lines_written = 0
    for outcome, placed in zip(result.lines, placements, strict=True):
        if not outcome.words:
            # A line with no ink parses cleanly and simply has nothing to store; a
            # line the engine could not read is a finding. Only the second is worth
            # reporting, so the caller is not handed a list of blank lines.
            if outcome.status == "unresolved":
                unresolved.append(outcome.label)
            continue
        lines_written += 1
        for order, box in enumerate(outcome.words, start=1):
            if box.word_id is None:
                raise ValueError(
                    f"{outcome.label}: word {order} ({box.text!r}) carries no Word id, so there is no "
                    f"row to point at. The stream came from a text file; only a database stream "
                    f"(quran.services.words.word_stream) can be stored."
                )
            rows.append(
                LineWord(
                    line=placed.line,
                    word_order=order,
                    word_id=box.word_id,
                    # The one piece of arithmetic in this module.
                    end_x=box.end_x + placed.origin_x,
                )
            )

    # Batched explicitly. Postgres does not override ``bulk_batch_size``, so Django
    # would send every row in one statement, and psycopg caps a statement at 65,535
    # parameters — seven columns means that breaks somewhere past 9,000 words. One
    # sura fits; a span covering two would not, and it would fail at write time after
    # the whole run had been paid for.
    LineWord.objects.bulk_create(rows, batch_size=1000)
    return SaveReport(
        lines_cleared=cleared,
        lines_written=lines_written,
        words_written=len(rows),
        unresolved=unresolved,
    )

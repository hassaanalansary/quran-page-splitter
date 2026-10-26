"""Store a confirmed page's words: where each word sits, in page coordinates.

Words are written by one path only — confirming a page in calibration, where every
word's box is the extent of the ink assigned to it. Nothing here runs the engine or
moves an edge: it is handed the confirmed lines and writes them down.
"""

from dataclasses import dataclass

from django.db import transaction

from api.models import Line, LineWord, Page


@dataclass(frozen=True)
class PageWordsReport:
    lines_written: int
    words_written: int


@transaction.atomic
def replace_page_words(page: Page, line_edits: list[dict]) -> PageWordsReport:
    """Replace the words of the named lines, whole lines at a time.

    Whole lines rather than single rows because the errors that matter move a word
    *between* lines, so both lines have to change together or the word is briefly on
    both or on neither. One call, one transaction.

    Each word carries **both** edges. ``start_x`` is the right one and the larger, so
    a reader can be shown the word lit from where it starts to where it ends. The
    boxes do not tile the line and may overlap.

    **The order words arrive in is the order they are stored in.** ``position`` is the
    array index, nothing else: the caller lists the line's words as the mushaf reads
    them, and nothing here re-derives a sequence from the geometry.
    """
    Page.objects.select_for_update().get(pk=page.pk)

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
    return PageWordsReport(lines_written=len(touched), words_written=len(rows))


__all__ = ["PageWordsReport", "replace_page_words"]

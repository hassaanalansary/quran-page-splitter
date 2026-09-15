"""Store where a word starts, not only where it ends.

The right edge used to be implied — the previous word's ``end_x``, and the line's own
right edge for the first word. That is enough to cut a line into words, which is all
this project needed. It is not enough to *highlight* one: measured over sura 7 the
printed gap between two words runs to a median of 13px, so a box drawn from the
previous word's end covers that whitespace as well as the word.

The engine already measured it. ``WordBox`` carries the word's own left and right from
its letter bodies, and only the left was ever read.

Existing rows are backfilled with the rule they were written under — the previous
word's ``end_x`` in reading order, and the line's right edge for the first word. That
reproduces exactly what the frontend was drawing, and is replaced by the measured edge
on the next run.
"""

from django.db import migrations, models


def fill_starts(apps, schema_editor):
    LineWord = apps.get_model("api", "LineWord")
    Line = apps.get_model("api", "Line")

    right_edge = {
        line["id"]: line["bbox_x"] + line["bbox_w"]
        for line in Line.objects.filter(words__isnull=False).values("id", "bbox_x", "bbox_w").distinct()
    }
    updates, line_id, previous = [], None, 0
    for row in LineWord.objects.order_by("line_id", "position").iterator(chunk_size=2000):
        if row.line_id != line_id:
            line_id = row.line_id
            previous = right_edge.get(line_id, row.end_x)
        # Never narrower than the cut itself, for a line whose box has since moved.
        row.start_x = max(previous, row.end_x)
        previous = row.end_x
        updates.append(row)
        if len(updates) >= 2000:
            LineWord.objects.bulk_update(updates, ["start_x"])
            updates = []
    if updates:
        LineWord.objects.bulk_update(updates, ["start_x"])


def drop_starts(apps, schema_editor):
    """Nothing to undo — the column goes with the reverse of the AddField."""


class Migration(migrations.Migration):
    dependencies = [("api", "0021_line_word_position")]

    operations = [
        migrations.AddField(
            model_name="lineword",
            name="start_x",
            field=models.PositiveIntegerField(
                default=0,
                help_text=(
                    "Page x where the word starts — its RIGHT edge, since Arabic runs right to "
                    "left, so this is the LARGER of the two."
                ),
            ),
            preserve_default=False,
        ),
        migrations.RunPython(fill_starts, drop_starts),
    ]

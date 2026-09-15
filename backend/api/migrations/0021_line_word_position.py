"""Give a line's words a stored reading order.

They were ordered by ``-end_x``, which is only reading order while the engine's
placement is right. It is not: a badly read line comes back with its cuts out of
order along the page, and the geometry then reports the mushaf as reading in an
order it does not. ``position`` carries the sequence instead.

Existing rows are backfilled from the order they had — ``-end_x`` per line — which is
the best available reading of data written under the old rule, and exactly wrong on
the lines the old rule got wrong. Those are re-run rather than trusted.

``unique(line, end_x)`` goes with it. It existed to make ``-end_x`` a total order,
and with the sequence stored it only costs: two words of a bad reading landing on one
pixel is something to show a reviewer, not a write to refuse.

The new constraint is **deferred**. Renumbering a line is a permutation, and Postgres
checks a unique constraint per row as an UPDATE runs rather than at the end of the
statement — so moving 0→1 while 1→0 collides halfway through a numbering that is
perfectly sound once it finishes.
"""

from django.db import migrations, models


def fill_positions(apps, schema_editor):
    LineWord = apps.get_model("api", "LineWord")
    rows = LineWord.objects.order_by("line_id", "-end_x").only("id", "line_id")
    updates, line_id, index = [], None, 0
    for row in rows.iterator(chunk_size=2000):
        if row.line_id != line_id:
            line_id, index = row.line_id, 0
        row.position = index
        updates.append(row)
        index += 1
        if len(updates) >= 2000:
            LineWord.objects.bulk_update(updates, ["position"])
            updates = []
    if updates:
        LineWord.objects.bulk_update(updates, ["position"])


def clear_positions(apps, schema_editor):
    """Nothing to undo — the column goes with the reverse of the AddField."""


class Migration(migrations.Migration):
    dependencies = [("api", "0020_word_cuts_and_job_kind")]

    operations = [
        migrations.RemoveConstraint(model_name="lineword", name="unique_line_word_end"),
        migrations.AddField(
            model_name="lineword",
            name="position",
            field=models.PositiveSmallIntegerField(
                default=0,
                help_text=(
                    "Where this word falls in the line's reading order, from 0. The sequence the "
                    "words table gives, not the order the cuts happen to sit in."
                ),
            ),
            preserve_default=False,
        ),
        migrations.RunPython(fill_positions, clear_positions),
        migrations.AlterModelOptions(
            name="lineword",
            options={"ordering": ("position",), "verbose_name": "Line Word", "verbose_name_plural": "Line Words"},
        ),
        migrations.AddConstraint(
            model_name="lineword",
            constraint=models.UniqueConstraint(
                fields=("line", "position"),
                name="unique_line_word_position",
                deferrable=models.Deferrable.DEFERRED,
            ),
        ),
    ]

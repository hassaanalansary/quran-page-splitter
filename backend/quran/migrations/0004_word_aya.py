"""The Quran text itself, and where each counting system draws its aya boundaries.

``Word`` numbers the 77,433 words of the Uthmani text from 1. ``Aya`` says, for one
counting system, which word an aya opens on — and nothing else, because within a
system the ayat tile that numbering without a gap, so the end of one is fixed by
the start of the next.

Both tables are filled by ``manage.py seed_quran``, which refuses to finish unless
the six systems come out at their known totals.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("quran", "0003_qiraa_above_rawi"),
    ]

    operations = [
        migrations.CreateModel(
            name="Word",
            fields=[
                (
                    "id",
                    models.PositiveIntegerField(
                        help_text="1-based index of this word in the Quran.",
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("text", models.CharField(help_text="Uthmani, exactly as Tanzil writes it.", max_length=64)),
                (
                    "paw_count",
                    models.PositiveSmallIntegerField(help_text="Ink blobs this spelling must produce."),
                ),
                (
                    "ijam_above",
                    models.PositiveSmallIntegerField(help_text="Dot groups required above the writing line."),
                ),
                (
                    "ijam_below",
                    models.PositiveSmallIntegerField(help_text="Dot groups required below the writing line."),
                ),
            ],
            options={
                "verbose_name": "Word",
                "verbose_name_plural": "Words",
                "db_table": "word",
                "ordering": ("id",),
            },
        ),
        migrations.CreateModel(
            name="Aya",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "number",
                    models.PositiveSmallIntegerField(help_text="Aya number within its sura, in THIS counting system."),
                ),
                (
                    "counting_system",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ayat",
                        to="quran.countingsystem",
                    ),
                ),
                (
                    "start_word",
                    models.ForeignKey(
                        help_text="First word of the aya.",
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ayat_starting_here",
                        to="quran.word",
                    ),
                ),
                (
                    "sura",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ayat",
                        to="quran.sura",
                    ),
                ),
            ],
            options={
                "verbose_name": "Aya",
                "verbose_name_plural": "Ayat",
                "db_table": "aya",
                "ordering": ("counting_system", "start_word"),
            },
        ),
        migrations.AddConstraint(
            model_name="aya",
            constraint=models.UniqueConstraint(
                fields=("counting_system", "sura", "number"), name="unique_aya_number_per_counting_system"
            ),
        ),
        migrations.AddConstraint(
            model_name="aya",
            constraint=models.UniqueConstraint(
                fields=("counting_system", "start_word"), name="unique_aya_start_per_counting_system"
            ),
        ),
    ]

"""Take ownership of the four reference tables, without touching a single row.

These tables were created by the ``api`` app and already hold data. Moving a model
between apps is a *state* change only — the tables, columns, indexes and
constraints are all exactly where they were — so every operation here is wrapped
in ``SeparateDatabaseAndState`` with no database operations at all. The matching
``DeleteModel`` half lives in ``api/0017``.

Two details are deliberate:

* The table names below are the ones on disk **today**, not the ones the models
  declare. ``api_countingsystem`` and ``qiraa`` are renamed for real in ``0002``;
  claiming the new names here would make Django believe a rename it never did.
* ``Rawi`` still carries ``counting_system`` and still lives in the ``qiraa``
  table, because at this point in history it is the old ``api.Qiraa`` under a new
  name. ``0003`` introduces the real ten-row ``Qiraa`` above it.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.CreateModel(
                    name="CountingSystem",
                    fields=[
                        (
                            "id",
                            models.BigAutoField(
                                auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                            ),
                        ),
                        ("name", models.CharField(max_length=256, unique=True)),
                        ("name_arabic", models.CharField(max_length=256, unique=True)),
                    ],
                    options={
                        "verbose_name": "Counting System",
                        "verbose_name_plural": "Counting Systems",
                        "db_table": "api_countingsystem",
                    },
                ),
                migrations.CreateModel(
                    name="Sura",
                    fields=[
                        ("number", models.PositiveSmallIntegerField(primary_key=True, serialize=False)),
                        ("transliteration", models.CharField(max_length=32, unique=True)),
                        ("name_arabic", models.CharField(max_length=32, unique=True)),
                    ],
                    options={"verbose_name": "Sura", "verbose_name_plural": "Suras", "db_table": "sura"},
                ),
                migrations.CreateModel(
                    name="Rawi",
                    fields=[
                        (
                            "id",
                            models.BigAutoField(
                                auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                            ),
                        ),
                        ("name", models.CharField(max_length=256, unique=True)),
                        ("name_arabic", models.CharField(max_length=256, unique=True)),
                        ("description", models.TextField(blank=True, default="")),
                        (
                            "counting_system",
                            models.ForeignKey(
                                null=True,
                                on_delete=django.db.models.deletion.CASCADE,
                                # No reverse accessor: 0003 gives the name "qiraat"
                                # to the new Qiraa model, and the two would clash
                                # while both fields briefly exist.
                                related_name="+",
                                to="quran.countingsystem",
                            ),
                        ),
                    ],
                    options={"verbose_name": "Rawi", "verbose_name_plural": "Rawis", "db_table": "qiraa"},
                ),
                migrations.CreateModel(
                    name="SuraAyaCount",
                    fields=[
                        (
                            "id",
                            models.BigAutoField(
                                auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                            ),
                        ),
                        ("count", models.PositiveSmallIntegerField()),
                        (
                            "counting_system",
                            models.ForeignKey(
                                null=True,
                                on_delete=django.db.models.deletion.CASCADE,
                                related_name="sura_aya_counts",
                                to="quran.countingsystem",
                            ),
                        ),
                        (
                            "sura",
                            models.ForeignKey(
                                on_delete=django.db.models.deletion.CASCADE,
                                related_name="aya_counts",
                                to="quran.sura",
                            ),
                        ),
                    ],
                    options={
                        "verbose_name": "Sura Aya Count",
                        "verbose_name_plural": "Sura Aya Counts",
                        "db_table": "sura_aya_count",
                    },
                ),
                migrations.AddConstraint(
                    model_name="suraayacount",
                    constraint=models.UniqueConstraint(
                        fields=("sura", "counting_system"), name="unique_sura_counting_system"
                    ),
                ),
            ],
        ),
    ]

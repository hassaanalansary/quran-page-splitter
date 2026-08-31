"""Hand the four reference models over to the ``quran`` app.

The other half of ``quran/0001``: that migration adopts the models into the new
app's state, this one drops them from this app's. Nothing happens to the database
— no table is created, dropped, renamed or rewritten here — so both halves are
``SeparateDatabaseAndState`` with an empty ``database_operations``.

Order matters inside the state block. ``Mushaf`` and ``Line`` are repointed at the
``quran`` models first, and ``SuraAyaCount`` goes before the two models it
references, so nothing is ever deleted while something still points at it.

``Mushaf.qiraa`` keeps its name here and is renamed to ``rawi`` in ``0018``; that
rename touches a real column, and this migration is meant to touch nothing.
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0016_mushaf_export_uniform_size_alter_line_line_png_and_more"),
        ("quran", "0001_initial"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name="mushaf",
                    name="qiraa",
                    field=models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="mushafs",
                        to="quran.rawi",
                    ),
                ),
                migrations.AlterField(
                    model_name="line",
                    name="sura",
                    field=models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="lines",
                        to="quran.sura",
                    ),
                ),
                migrations.RemoveConstraint(
                    model_name="suraayacount",
                    name="unique_sura_counting_system",
                ),
                migrations.DeleteModel(name="SuraAyaCount"),
                migrations.DeleteModel(name="Qiraa"),
                migrations.DeleteModel(name="Sura"),
                migrations.DeleteModel(name="CountingSystem"),
            ],
        ),
    ]

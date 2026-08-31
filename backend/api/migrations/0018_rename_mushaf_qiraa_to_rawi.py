"""Rename ``Mushaf.qiraa`` to ``Mushaf.rawi``, matching what the column holds.

A mushaf is printed in a riwaya. The wire keeps the older, colloquial name — the
API still sends and accepts ``qiraa: "Hafs"``, and exported work bundles carry it
that way — so this rename stops at the model layer; ``services/mushaf.py`` maps
between the two. Renaming the wire field instead would break every bundle already
exported.

Split out of ``0017`` because this one *does* touch the database: the column
becomes ``rawi_id``.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0017_move_reference_models_to_quran"),
        # The table the foreign key points at is renamed there.
        ("quran", "0002_rename_reference_tables"),
    ]

    operations = [
        migrations.RenameField(model_name="mushaf", old_name="qiraa", new_name="rawi"),
    ]

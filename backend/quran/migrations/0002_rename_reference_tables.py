"""Rename the two tables whose names no longer say what they hold.

The first real database work in this app.

* ``api_countingsystem`` -> ``counting_system``. It is the only one of the four
  that never declared a ``db_table``, so it carried the ``api_`` prefix Django
  generates. Moving the model to another app would silently change that generated
  name, which is exactly why the rename is written out here instead.
* ``qiraa`` -> ``rawi``. The twenty rows in it are transmitters, not recitations.
  This has to happen before ``0003`` creates the real ten-row ``Qiraa``, because
  that model wants the ``qiraa`` name back.

Both tables are referenced by foreign keys from ``mushaf`` and ``sura_aya_count``.
Django's SQLite backend rebuilds the referencing tables when the SQLite version
cannot follow a rename atomically, and PostgreSQL follows renames on its own, so
no manual constraint work belongs here.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("quran", "0001_initial"),
        # After api has let go of its copies, so only one model claims each table.
        ("api", "0017_move_reference_models_to_quran"),
    ]

    operations = [
        migrations.AlterModelTable(name="countingsystem", table="counting_system"),
        migrations.AlterModelTable(name="rawi", table="rawi"),
    ]

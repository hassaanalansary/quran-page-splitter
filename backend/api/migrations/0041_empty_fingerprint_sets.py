"""Contents keys, step 1: empty every fingerprint set.

A set's groups were keyed by (role, mark type); a key now says everything a blob holds,
bodies included (0042), so the old groups mean nothing under it. The set is emptied and
marked for a rebuild: it is rebuilt from the confirmed pages at its first use. Removed
shapes go with it — they named the old kinds.

A migration of its own, so the rows are gone and committed before 0042 alters the
tables: Postgres refuses to alter a table with deletes pending in the same transaction.
"""

from django.db import migrations


def empty_fingerprint_sets(apps, schema_editor):
    apps.get_model("api", "FingerprintShape").objects.all().delete()
    apps.get_model("api", "FingerprintGroup").objects.all().delete()
    apps.get_model("api", "RemovedShape").objects.all().delete()
    apps.get_model("api", "FingerprintLibrary").objects.update(needs_rebuild=True, library_version=0)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0040_fingerprint_set"),
    ]

    operations = [
        migrations.RunPython(empty_fingerprint_sets, migrations.RunPython.noop),
    ]

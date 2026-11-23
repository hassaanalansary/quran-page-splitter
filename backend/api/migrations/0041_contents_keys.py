"""Contents keys: the fingerprint set groups shapes by what their blobs hold, and keeps
the hand's habit counts.

A set's groups were keyed by (role, mark type); a key now says everything a blob holds,
bodies included, so the old groups mean nothing under it. The set is emptied and marked
for a rebuild: it is rebuilt from the confirmed pages at its first use. Removed shapes
go with it — they named the old kinds.
"""

from django.db import migrations, models


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
        migrations.RemoveField(model_name="fingerprintgroup", name="subtype"),
        migrations.AddField(
            model_name="fingerprintgroup",
            name="key",
            field=models.TextField(db_index=True, default=""),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="fingerprintgroup",
            name="shape",
            field=models.TextField(blank=True, db_index=True, default=""),
        ),
        migrations.RemoveField(model_name="removedshape", name="subtype"),
        migrations.AddField(
            model_name="removedshape",
            name="key",
            field=models.TextField(default=""),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name="fingerprintlibrary",
            name="habits",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="calibrationrevision",
            name="habits",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]

"""Contents keys, step 2: the fingerprint set groups shapes by what their blobs hold,
and keeps the hand's habit counts. The tables are empty by now (0041)."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0041_empty_fingerprint_sets"),
    ]

    operations = [
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

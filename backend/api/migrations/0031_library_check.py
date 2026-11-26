# "Looks right" marks on the fingerprint library's examples, kept on the example
# blob (a confirmed page's snapshot and blob id) with the label it was looked at under.

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0030_drop_word_status_and_job_log"),
    ]

    operations = [
        migrations.CreateModel(
            name="LibraryCheck",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("blob_id", models.PositiveIntegerField()),
                ("role", models.CharField(max_length=8)),
                ("subtype", models.CharField(blank=True, default="", max_length=32)),
                (
                    "mushaf",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="library_checks",
                        to="api.mushaf",
                    ),
                ),
                (
                    "snapshot",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="library_checks",
                        to="api.calibrationsnapshot",
                    ),
                ),
            ],
            options={
                "verbose_name": "Library Check",
                "verbose_name_plural": "Library Checks",
                "db_table": "library_check",
                "constraints": [
                    models.UniqueConstraint(fields=("mushaf", "snapshot", "blob_id"), name="unique_library_check")
                ],
            },
        ),
    ]

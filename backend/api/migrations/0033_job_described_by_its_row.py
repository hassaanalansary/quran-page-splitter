"""A job is described by its row: it starts ``queued``, carries its runner's inputs
in ``params``, and records who claimed it and when.

Written by hand. ``started_at`` and ``started_by`` are *renamed*, so the rows keep
their values: the autodetector proposed dropping both columns and adding new ones.
"""

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


def set_run_started_at_of_existing_jobs(apps, schema_editor):
    """Until now a job began the moment it was requested, so the two times are the same."""
    ProcessJob = apps.get_model("api", "ProcessJob")
    ProcessJob.objects.filter(run_started_at__isnull=True).update(run_started_at=models.F("requested_at"))


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0032_drop_calibration_experimental"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name="processjob",
            name="process_job_mushaf_recent",
        ),
        migrations.RenameField(
            model_name="processjob",
            old_name="started_at",
            new_name="requested_at",
        ),
        migrations.RenameField(
            model_name="processjob",
            old_name="started_by",
            new_name="requested_by",
        ),
        migrations.AlterField(
            model_name="processjob",
            name="requested_at",
            field=models.DateTimeField(
                default=django.utils.timezone.now,
                help_text="When the job was asked for. A queued job has been requested, not started.",
            ),
        ),
        migrations.AlterField(
            model_name="processjob",
            name="requested_by",
            field=models.ForeignKey(
                blank=True,
                help_text="Who asked for this job. The per-user limit counts by it, and the runner acts as this user.",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="process_jobs",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddIndex(
            model_name="processjob",
            index=models.Index(fields=["mushaf", "-requested_at"], name="process_job_mushaf_recent"),
        ),
        migrations.AddField(
            model_name="processjob",
            name="params",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text="The runner's inputs, as the request gave them. What they are depends on the kind.",
            ),
        ),
        migrations.AddField(
            model_name="processjob",
            name="run_started_at",
            field=models.DateTimeField(
                blank=True,
                help_text="When a worker claimed the job and began. Null while it is queued.",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="processjob",
            name="claimed_by_worker",
            field=models.CharField(
                blank=True,
                default="",
                help_text="The name of the worker that claimed the job. A stopping worker flags its own jobs by it.",
                max_length=255,
            ),
        ),
        migrations.AlterField(
            model_name="processjob",
            name="state",
            field=models.CharField(
                choices=[
                    ("queued", "Queued"),
                    ("running", "Running"),
                    ("completed", "Completed"),
                    ("aborted_line_detection", "Aborted (line detection)"),
                    ("cancelled", "Cancelled"),
                    ("error", "Error"),
                    ("interrupted", "Interrupted"),
                ],
                default="queued",
                max_length=32,
            ),
        ),
        migrations.RunPython(set_run_started_at_of_existing_jobs, migrations.RunPython.noop),
    ]

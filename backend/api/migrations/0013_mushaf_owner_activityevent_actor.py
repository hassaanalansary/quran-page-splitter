"""Give every mushaf an owner, and scope its name to that owner.

Hand-written rather than generated, because adding a non-null FK to a populated
table needs three ordered steps and they belong in one migration so there is a
single `migrate` to run:

  1. add ``owner`` nullable,
  2. backfill it,
  3. tighten it to non-null and swap the global name constraint for a per-owner
     one.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def assign_existing_mushafs(apps, schema_editor):
    """Hand pre-existing mushafs to the first superuser.

    Everything in the database predates accounts, so there is exactly one
    sensible owner: whoever runs this. Preferring a superuser (oldest first)
    keeps it deterministic when several accounts already exist.
    """
    User = apps.get_model(settings.AUTH_USER_MODEL)
    Mushaf = apps.get_model("api", "Mushaf")

    orphans = Mushaf.objects.filter(owner__isnull=True)
    if not orphans.exists():
        return

    owner = User.objects.filter(is_superuser=True).order_by("date_joined").first()
    if owner is None:
        owner = User.objects.order_by("date_joined").first()
    if owner is None:
        raise RuntimeError(
            f"{orphans.count()} mushaf(s) exist but there is no account to own them. "
            "Run `manage.py createsuperuser` first, then re-run this migration."
        )
    orphans.update(owner=owner)


def unassign(apps, schema_editor):
    """Reverse: drop the ownership again so the migration can be rolled back."""
    Mushaf = apps.get_model("api", "Mushaf")
    Mushaf.objects.update(owner=None)


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("api", "0012_alter_processingrun_status"),
    ]

    operations = [
        # 1. Nullable first — the rows that exist have no owner yet.
        migrations.AddField(
            model_name="mushaf",
            name="owner",
            field=models.ForeignKey(
                null=True,
                help_text="Who created this mushaf. Deleting the account deletes their mushafs.",
                on_delete=django.db.models.deletion.CASCADE,
                related_name="mushafs",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(assign_existing_mushafs, unassign),
        # 2. Now that every row has one, require it.
        migrations.AlterField(
            model_name="mushaf",
            name="owner",
            field=models.ForeignKey(
                help_text="Who created this mushaf. Deleting the account deletes their mushafs.",
                on_delete=django.db.models.deletion.CASCADE,
                related_name="mushafs",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        # 3. Names are unique per owner, not globally.
        migrations.AlterField(
            model_name="mushaf",
            name="name",
            field=models.CharField(max_length=256),
        ),
        migrations.AddConstraint(
            model_name="mushaf",
            constraint=models.UniqueConstraint(fields=("owner", "name"), name="unique_owner_mushaf_name"),
        ),
        # The audit feed has always recorded what happened but never who.
        migrations.AddField(
            model_name="activityevent",
            name="actor",
            field=models.ForeignKey(
                blank=True,
                null=True,
                help_text=(
                    "Who did it. Null for events recorded before accounts existed, and for "
                    "anything a background worker does on nobody's behalf."
                ),
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="activity_events",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]

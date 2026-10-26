"""Explicit, backup-first restart of calibration; never run by an ordinary job."""

import shutil
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from api.models import (
    ActivityTypeChoices,
    CalibrationReview,
    CalibrationSettings,
    LineWord,
    Mushaf,
    Page,
    ProcessJob,
)
from api.services import activity, bundle, calibration


class Command(BaseCommand):
    help = (
        "Preview a calibration restart. --apply requires --backup; the pages' words are cleared "
        "(words exist only by confirmation) and their history is retained."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("mushaf_id")
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--backup", type=Path)

    @transaction.atomic
    def handle(self, *args: Any, **options: Any) -> None:
        try:
            mushaf = Mushaf.objects.select_for_update().get(pk=options["mushaf_id"])
        except (Mushaf.DoesNotExist, ValueError) as exc:
            raise CommandError("Use the full mushaf UUID.") from exc
        if ProcessJob.objects.filter(mushaf=mushaf, state="running").exists():
            raise CommandError("Stop processing jobs before restarting calibration.")
        pages = {p.page_number: p for p in Page.objects.select_for_update().filter(mushaf=mushaf)}
        plans = []
        for review in CalibrationReview.objects.select_for_update().filter(mushaf=mushaf).order_by("page_number"):
            if not review.payload.get("lines") and review.confirmed_revision is None:
                continue
            plans.append(review)
            self.stdout.write(f"Page {review.page_number}: restart labels; clear its words.")
        if not options["apply"]:
            self.stdout.write(
                f"DRY RUN: {len(plans)} pages. Nothing changed. Use --apply --backup <new-file.zip> to proceed."
            )
            return
        backup = options.get("backup")
        if backup is None:
            raise CommandError("--backup is required with --apply.")
        if not plans:
            self.stdout.write("No active calibration pages to restart.")
            return
        # Exclusive creation prevents overwriting a prior recovery point.
        _, archive = bundle.build(mushaf.id, user=mushaf.owner)
        try:
            with backup.open("xb") as output:
                archive.seek(0)
                shutil.copyfileobj(archive, output)
        except OSError as exc:
            raise CommandError(f"Backup failed; nothing reset: {exc}") from exc
        finally:
            archive.close()
        for review in plans:
            page = pages.get(review.page_number)
            if page is None:
                raise CommandError(f"Page {review.page_number} disappeared; transaction rolled back.")
            LineWord.objects.filter(line__page=page).delete()
            review.revision += 1
            review.confirmed_revision = None
            review.payload = {}
            review.save(update_fields=["revision", "confirmed_revision", "payload", "updated_at"])
            activity.emit(
                mushaf,
                ActivityTypeChoices.CALIBRATION_SAVED,
                {"page_number": review.page_number, "action": "restart", "revision": review.revision},
                actor=mushaf.owner,
            )
        setting = CalibrationSettings.objects.filter(mushaf=mushaf).first()
        if setting:
            setting.experimental = False
            setting.revision += 1
            setting.save()
        calibration._LIBRARIES.clear()
        self.stdout.write(
            self.style.SUCCESS(
                f"Restarted {len(plans)} pages. Backup: {backup.resolve()}. "
                "Old revisions and snapshots remain archived, excluded from teaching."
            )
        )

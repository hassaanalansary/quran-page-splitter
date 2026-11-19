"""Explicit, backup-first restart of calibration from a real zero; never run by an ordinary job."""

from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from api.models import Mushaf
from api.services.calibration_restart import back_up_calibration, delete_calibration_labels, list_pages_to_restart
from api.services.jobs.queries import find_active_job_of_mushaf


class Command(BaseCommand):
    help = (
        "Preview a calibration restart. --apply requires --backup. A real zero: every review and "
        "revision, the fingerprint set and the pages' words go; the line snapshots, settings and "
        "activity log stay."
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
        if find_active_job_of_mushaf(mushaf.id) is not None:
            raise CommandError("Stop processing jobs before restarting calibration.")
        pages = list_pages_to_restart(mushaf)
        for review in pages:
            self.stdout.write(f"Page {review.page_number}: delete its labels, history and words.")
        if not options["apply"]:
            self.stdout.write(
                f"DRY RUN: {len(pages)} pages. Nothing changed. Use --apply --backup <new-file.zip> to proceed."
            )
            return
        backup = options.get("backup")
        if backup is None:
            raise CommandError("--backup is required with --apply.")
        try:
            back_up_calibration(mushaf, backup)
        except OSError as exc:
            raise CommandError(f"Backup failed; nothing reset: {exc}") from exc
        delete_calibration_labels(mushaf, pages, user=mushaf.owner)
        self.stdout.write(
            self.style.SUCCESS(
                f"Restarted {len(pages)} pages from zero. Backup: {backup.resolve()}. "
                "The line snapshots and settings remain."
            )
        )

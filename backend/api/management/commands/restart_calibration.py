"""Explicit, backup-first restart of calibration; never run by an ordinary word job."""

import copy
import shutil
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from api.models import (
    ActivityTypeChoices,
    CalibrationReview,
    CalibrationRevisionKind,
    CalibrationSettings,
    LineWord,
    LineWordStatus,
    Mushaf,
    Page,
    ProcessJob,
)
from api.services import activity, bundle, calibration


class Command(BaseCommand):
    help = "Preview a calibration restart. --apply requires --backup; old manual cuts and history are retained."

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
            first = review.revisions.filter(kind=CalibrationRevisionKind.PROCESSED).order_by("number").first()
            if first is None or not calibration._sources_current(mushaf, first.payload.get("lines", [])):
                raise CommandError(
                    f"Page {review.page_number}: original geometry is unavailable or changed; nothing reset."
                )
            # The *latest* archive before calibration began: each one carries every
            # hand-cut line seen so far, so the last is the complete, current set.
            legacy = (
                review.revisions.filter(kind=CalibrationRevisionKind.LEGACY, number__lt=first.number)
                .order_by("-number")
                .first()
            )
            old = {row["line_number"]: row for row in legacy.payload.get("legacy_lines", [])} if legacy else {}
            plans.append((review, first, old))
            self.stdout.write(
                f"Page {review.page_number}: restart labels; restore {len(old)} pre-calibration manual lines; "
                "other lines return to the first canonical reading."
            )
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
        for review, first, old in plans:
            page = pages.get(review.page_number)
            if page is None:
                raise CommandError(f"Page {review.page_number} disappeared; transaction rolled back.")
            for row in first.payload["lines"]:
                line = page.lines.get(pk=row["line_id"])
                legacy = old.get(row["line_number"])
                words = legacy["words"] if legacy else row["words"]
                LineWord.objects.filter(line=line).delete()
                LineWord.objects.bulk_create(
                    [
                        LineWord(
                            line=line,
                            word_id=w["word_id"],
                            position=w.get("position", i),
                            start_x=w["start_x"],
                            end_x=w["end_x"],
                        )
                        for i, w in enumerate(words)
                    ]
                )
                LineWordStatus.objects.update_or_create(
                    line=line,
                    defaults={
                        "edited": bool(legacy),
                        "status": row.get("status") or "scored",
                        "reason": row.get("reason") or "",
                        "deviations": 0,
                        "ties": 0,
                    },
                )
            review.revision += 1
            review.confirmed_revision = None
            review.payload = {"legacy_lines": copy.deepcopy(list(old.values()))}
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
        calibration._PREPARED.clear()
        self.stdout.write(
            self.style.SUCCESS(
                f"Restarted {len(plans)} pages. Backup: {backup.resolve()}. "
                "Old revisions and snapshots remain archived, excluded from teaching."
            )
        )

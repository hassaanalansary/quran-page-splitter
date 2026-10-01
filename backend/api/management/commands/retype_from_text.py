"""Give marks typed before their type existed the name their text gives them.

The round zero (``۟``, a letter written and never read) and the upright zero (``۠``)
had no type of their own until 2026-09-30, so reviewers typed them *sukun*; nor had the
embraced pause sign, whose three loose dots were typed as i'jam dots. The text tells
them apart letter by letter, so the check (``api.services.calibration_marks``) finds
every such mark: typed by the old name, where its word's text has the new. Left as they
are, they teach the examples that a ring is a sukun.

Dry run by default. ``--apply`` retypes them on every page's draft and, for a confirmed
page, confirms it again: a new confirmed revision, identical but for those types — the
old one stays in the page's history, as confirmations always do. Nothing else changes:
not a role, not a word, not an edge.
"""

import copy
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import transaction

from api.models import (
    ActivityTypeChoices,
    CalibrationReview,
    CalibrationRevision,
    CalibrationRevisionKind,
    Mushaf,
    ProcessJob,
)
from api.services import activity, calibration
from api.services import calibration_marks as text_marks
from core.word_boundary.examples import build_type_index

#: What a reviewer typed before the text's own type existed, and that type.
RENAMED = {("sukun", "roundZero"), ("sukun", "rectZero"), ("ijamDot", "waqfMuanaqa")}


class Command(BaseCommand):
    help = "Retype marks typed by an old name — sukun for a zero, dots for the embraced pause. Dry run unless --apply."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("mushaf_id")
        parser.add_argument("--apply", action="store_true")

    @transaction.atomic
    def handle(self, *args: Any, **options: Any) -> None:
        try:
            mushaf = Mushaf.objects.select_for_update().get(pk=options["mushaf_id"])
        except (Mushaf.DoesNotExist, ValueError) as exc:
            raise CommandError("Use the full mushaf UUID.") from exc
        if ProcessJob.objects.filter(mushaf=mushaf, state="running").exists():
            raise CommandError("Stop processing jobs first.")
        if not calibration._follows_text(mushaf):
            raise CommandError("The text is Hafs's; this mushaf is printed in another riwaya.")
        total = 0
        for review in CalibrationReview.objects.select_for_update().filter(mushaf=mushaf).order_by("page_number"):
            if not review.payload.get("lines"):
                continue
            approval = calibration._approval(review)
            draft = _renamed(mushaf, review.page_number, review.payload)
            confirmed = _renamed(mushaf, review.page_number, approval.payload) if approval else {}
            if not draft and not confirmed:
                continue
            total += len(draft) + len(confirmed)
            where = sorted({f"l{line}#{blob}" for line, blob in {**draft, **confirmed}})
            self.stdout.write(
                f"Page {review.page_number}: {len(confirmed)} on its confirmation, {len(draft)} on its draft — "
                + ", ".join(where[:12])
                + (" …" if len(where) > 12 else "")
            )
            if not options["apply"]:
                continue
            payload = copy.deepcopy(review.payload)
            _retype(payload, draft)
            review.revision += 1
            if approval is not None and confirmed:
                record = copy.deepcopy(approval.payload)
                _retype(record, confirmed)
                record["retyped_from_text"] = sorted(f"{line}:{blob}" for line, blob in confirmed)
                CalibrationRevision.objects.create(
                    review=review, number=review.revision, kind=CalibrationRevisionKind.CONFIRMED, payload=record
                )
                if review.confirmed_revision == approval.number:
                    review.confirmed_revision = review.revision
            review.payload = payload
            review.save(update_fields=["revision", "confirmed_revision", "payload", "updated_at"])
            activity.emit(
                mushaf,
                ActivityTypeChoices.CALIBRATION_SAVED,
                {"page_number": review.page_number, "action": "retype-from-text", "revision": review.revision},
                actor=mushaf.owner,
            )
        if not options["apply"]:
            self.stdout.write(f"DRY RUN: {total} marks to retype. Nothing changed. Use --apply to retype them.")
            return
        calibration._TYPED.clear()
        self.stdout.write(self.style.SUCCESS(f"Retyped {total} marks."))


def _renamed(mushaf: Mushaf, page: int, document: dict) -> dict[tuple[int, int], str]:
    """(line number, blob id) → the text's type, for every mark typed by its old name."""
    rows = [row for row in document.get("lines", []) if not row.get("readonly")]
    if not rows:
        return {}
    _, marks = calibration._page_marks(mushaf, rows)
    index = build_type_index(calibration._confirmed_types(mushaf, page))
    checks = text_marks.check_rows(rows, document["stream"], marks, index, ijam=mushaf.ijam_mode != "ignore")
    found: dict[tuple[int, int], str] = {}
    for row in rows:
        blobs = {blob["id"]: blob for blob in row["blobs"]}
        for check in checks.get(row["snapshot_id"], {}).values():
            for ident in check.disagree:
                kind = check.types[ident]
                if (blobs[ident].get("subtype"), kind) in RENAMED:
                    found[(row["line_number"], ident)] = kind
    return found


def _retype(document: dict, renamed: dict[tuple[int, int], str]) -> None:
    for row in document.get("lines", []):
        for blob in row["blobs"]:
            kind = renamed.get((row["line_number"], blob["id"]))
            if kind:
                blob["subtype"] = kind

"""Check every shape of a mushaf's stored fingerprint set against its confirmed pages.

The set is a second copy of what the confirmed pages say; this says where they part.
A failure flags the set ``needs_rebuild`` (unless ``--dry-run``), and Library mode then
offers a Rebuild.
"""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from api.models import Mushaf
from api.services.fingerprint_updates import check_every_shape_matches_labels


class Command(BaseCommand):
    help = "Check a mushaf's fingerprint set against its confirmed pages; flag it for a Rebuild if they disagree."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("mushaf_id")
        parser.add_argument("--dry-run", action="store_true", help="Report only; never flag the set.")

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            mushaf = Mushaf.objects.get(pk=options["mushaf_id"])
        except (Mushaf.DoesNotExist, ValueError) as exc:
            raise CommandError("Use the full mushaf UUID.") from exc
        found = check_every_shape_matches_labels(mushaf, flag=not options["dry_run"])
        for title, keys in (
            ("kept under another label than its page's", found.wrong_label),
            ("no longer an example of a confirmed page", found.unconfirmed),
            ("removed, yet still kept", found.removed_but_kept),
        ):
            for snapshot_id, blob_id in keys:
                self.stdout.write(f"blob {blob_id} of snapshot {snapshot_id}: {title}")
        if found.passed:
            self.stdout.write(self.style.SUCCESS("The set agrees with every confirmed page."))
        else:
            flagged = "" if options["dry_run"] else " The set is flagged for a Rebuild."
            self.stdout.write(self.style.WARNING(f"The set disagrees with the confirmed pages.{flagged}"))

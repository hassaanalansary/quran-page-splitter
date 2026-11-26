"""Regroup a mushaf's stored fingerprint set from its confirmed pages, here and now.

The same regroup as Library mode's Rebuild button, without the background job: for a
set flagged ``needs_rebuild``, or after the grouping code changed.
"""

from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from api.models import Mushaf
from api.services.fingerprint_rebuild import rebuild_fingerprint_set


class Command(BaseCommand):
    help = "Regroup a mushaf's fingerprint set from its confirmed pages (removed blobs stay out, looks-right stays)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("mushaf_id")

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            mushaf = Mushaf.objects.get(pk=options["mushaf_id"])
        except (Mushaf.DoesNotExist, ValueError) as exc:
            raise CommandError("Use the full mushaf UUID.") from exc
        library_row = rebuild_fingerprint_set(mushaf)
        groups = library_row.groups.count()
        shapes = library_row.shapes.count()
        self.stdout.write(
            self.style.SUCCESS(f"Rebuilt: version {library_row.version}, {groups} fingerprints, {shapes} kept shapes.")
        )

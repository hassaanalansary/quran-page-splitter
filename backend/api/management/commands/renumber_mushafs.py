"""Rewrite every mushaf's sura/aya numbering from a single forward walk.

A repair, run once after the change that made the walk the only writer of
``Line.sura`` and ``Segment.aya_number``. Before it, processing also wrote those
columns — from its own run's seed, over its own page range — so a mushaf whose
pages were processed in several runs ends up holding one range's numbering spliced
into another's. The app never showed it, because the review UI derives the
numbering rather than reading these columns, so the drift sat there unseen.

Start with ``--dry-run``: it walks and validates without touching a row.

    python manage.py renumber_mushafs --dry-run
    python manage.py renumber_mushafs
    python manage.py renumber_mushafs --mushaf <uuid>

Every mushaf is also checked against its counting system — see
``coordinates.plan_renumber``, which compares each fully covered sura's separator
count with the aya count that sura has in the mushaf's own qiraa. A mismatch is a
genuinely missed or invented separator on some page. It is reported, not treated
as a refusal: the walk is still the best numbering available, and withholding it
would only leave the columns null. Fix those pages in review and run this again.
"""

import uuid
from typing import Any

from django.core.management.base import BaseCommand, CommandParser

from api.models import Mushaf
from api.services import coordinates


class Command(BaseCommand):
    help = "Rewrite Line.sura and Segment.aya_number for every mushaf from one forward walk."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--mushaf", type=uuid.UUID, help="Only this mushaf (default: all of them).")
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would change and whether it validates, writing nothing.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        mushafs = Mushaf.objects.select_related("rawi__qiraa__counting_system").order_by("name")
        if options["mushaf"]:
            mushafs = mushafs.filter(id=options["mushaf"])
        if not mushafs:
            self.stderr.write(self.style.ERROR("no mushafs matched."))
            return

        dry_run: bool = options["dry_run"]
        total_changes = flagged = 0
        for mushaf in mushafs:
            plan = coordinates.renumber_mushaf(mushaf, dry_run=dry_run)
            total_changes += plan.changes
            system = mushaf.rawi.counting_system if mushaf.rawi else None
            head = (
                f"{mushaf.name[:38]:<40} {(system.name if system else '(no rawi)'):<14} "
                f"{plan.pages:>4} pages  "
                f"{plan.segments_changed:>5} segments, {plan.lines_changed:>4} lines  "
                f"ends {plan.exit_state[0]}:{plan.exit_state[1]}"
            )
            if not plan.clean:
                flagged += 1
                state = "  would write" if dry_run else "  written"
                self.stdout.write(self.style.WARNING(head + state + f"  ({len(plan.problems)} sura(s) off)"))
                for problem in plan.problems:
                    self.stdout.write(self.style.WARNING(f"    {problem}"))
            elif plan.changes:
                self.stdout.write(self.style.WARNING(head + ("  would write" if dry_run else "  written")))
            else:
                self.stdout.write(self.style.SUCCESS(head + "  already correct"))

        if flagged:
            self.stdout.write(
                self.style.WARNING(
                    f"\n{flagged} mushaf(s) have suras whose separator count does not match their qiraa. "
                    f"The numbering above is still the best forward walk of what is stored; those pages "
                    f"need a separator added or removed in review."
                )
            )
        if dry_run and total_changes:
            self.stdout.write(f"\n{total_changes} row(s) would change. Re-run without --dry-run to write them.")

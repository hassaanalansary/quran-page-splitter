"""Seed everything this app owns: reference data, the word list, and the aya maps.

Run after migrating::

    python manage.py seed_quran

Idempotent. The reference tables are upserted by natural key, so rows keep their
identity — which matters for rawis, whose names are stored on mushafs and inside
exported bundles. ``Word`` and ``Aya`` are rebuilt from scratch inside one
transaction, and every check has to pass before that transaction is allowed to
commit: a seed that is wrong is worse than no seed, because everything downstream
would quietly believe it.
"""

from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand, CommandParser
from django.db import transaction

from quran.services.quran_text import DEFAULT_QURAN_TEXT_PATH
from quran.services.seeding import (
    DEFAULT_BOUNDARIES_PATH,
    SeedError,
    format_report,
    seed_quran_text,
)
from quran.services.suras import seed_reference_data


class Command(BaseCommand):
    help = "Seed counting systems, qiraat, rawis, suras, aya counts, the word list and the aya maps."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--quran", type=Path, default=DEFAULT_QURAN_TEXT_PATH, help="Tanzil 'sura|aya|text' file.")
        parser.add_argument(
            "--boundaries",
            type=Path,
            default=DEFAULT_BOUNDARIES_PATH,
            help="Aya boundary seed, from `manage.py build_aya_boundaries`.",
        )
        parser.add_argument(
            "--reference-only",
            action="store_true",
            help="Seed only counting systems, qiraat, rawis, suras and aya counts.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        seed_reference_data()
        self.stdout.write("seeded counting systems, qiraat, rawis, suras and aya counts")
        if options["reference_only"]:
            return

        try:
            with transaction.atomic():
                words, ayat, problems = seed_quran_text(
                    quran_path=options["quran"], boundaries_path=options["boundaries"]
                )
                report = format_report(words, ayat, problems)
                if problems:
                    # Roll the whole rebuild back: the previous contents, or an
                    # empty pair of tables, beats a plausible-looking wrong one.
                    raise SeedError(report)
        except SeedError as error:
            self.stderr.write(self.style.ERROR(str(error)))
            self.stderr.write(self.style.ERROR("nothing was written."))
            return

        self.stdout.write(report)
        self.stdout.write(self.style.SUCCESS("seeded the word list and the aya maps"))

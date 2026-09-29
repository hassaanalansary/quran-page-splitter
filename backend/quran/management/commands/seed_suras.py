"""Seed reference data: counting systems, qiraat, suras and per-system aya counts.

Run after migrating: ``python manage.py seed_suras``. Idempotent. Reads the
committed ``reference_data.json`` (see the ``export_reference_data`` command).
"""

from typing import Any

from django.core.management.base import BaseCommand

from quran.services.suras import seed_reference_data


class Command(BaseCommand):
    help = "Seed reference data: counting systems, qiraat, suras and per-system aya counts."

    def handle(self, *args: Any, **options: Any) -> None:
        seed_reference_data()
        self.stdout.write(self.style.SUCCESS("Seeded reference data (counting systems, qiraat, suras, aya counts)."))

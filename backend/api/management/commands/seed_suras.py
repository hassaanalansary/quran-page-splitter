"""Seed reference data: qiraat, suras, and per-qiraa aya counts.

Run after migrating: ``python manage.py seed_suras``. Idempotent.
"""

from typing import Any

from django.core.management.base import BaseCommand

from api.services.suras import seed_reference_data


class Command(BaseCommand):
    help = "Seed reference data: qiraat, suras, and per-qiraa aya counts."

    def handle(self, *args: Any, **options: Any) -> None:
        seed_reference_data()
        self.stdout.write(self.style.SUCCESS("Seeded reference data (qiraat, suras, aya counts)."))

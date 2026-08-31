"""Counting system reference-data service (list the counting systems for the mushaf picker).

Counting systems and qiraat are managed elsewhere (already in the DB); this just
exposes them for selection. See ``services.suras`` for the sura/aya-count side.
"""

from django.db.models.functions import Lower

from quran.models import CountingSystem


def list_counting_systems() -> list[dict]:
    """List every counting system as ``{name, name_arabic}``, ordered case-insensitively by name."""
    return [{"name": cs.name, "name_arabic": cs.name_arabic} for cs in CountingSystem.objects.order_by(Lower("name"))]

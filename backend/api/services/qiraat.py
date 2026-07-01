"""Qiraa reference-data service (list the qiraat for the mushaf picker).

Counting systems and qiraat are managed elsewhere (already in the DB); this just
exposes them for selection. See ``services.suras`` for the sura/aya-count side.
"""

from django.db.models.functions import Lower

from api.models import Qiraa


def list_qiraat() -> list[dict]:
    """List every qiraa as ``{name, counting_system}``, ordered case-insensitively by name."""
    return [
        {"name": q.name, "counting_system": q.counting_system.name}
        for q in Qiraa.objects.select_related("counting_system").order_by(Lower("name"))
    ]

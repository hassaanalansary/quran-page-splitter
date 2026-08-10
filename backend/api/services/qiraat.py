"""Qiraa reference-data service (list the qiraat for the mushaf picker).

Counting systems and qiraat are managed elsewhere (already in the DB); this just
exposes them for selection. See ``services.suras`` for the sura/aya-count side.
"""

from django.db.models.functions import Lower

from api.models import CountingSystem, Qiraa


def list_qiraat(lang: str | None = None) -> list[dict]:
    """List every qiraa as ``{name, counting_system}``, ordered case-insensitively by name."""
    arabic = lang == "ar"
    return [
        {
            "name": q.name_arabic if arabic else q.name,
            "counting_system": _system_label(q.counting_system, arabic),
        }
        for q in Qiraa.objects.select_related("counting_system").order_by(Lower("name"))
    ]


def _system_label(system: CountingSystem | None, arabic: bool) -> str:
    """Counting-system name in the requested language, or ``""`` when a qiraa has none."""
    if system is None:
        return ""
    return system.name_arabic if arabic else system.name

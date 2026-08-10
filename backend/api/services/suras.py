"""Reference-data services: sura listing and reference-data seeding.

Seeding reads a single ``reference_data.json`` (exported from a filled DB via the
``export_reference_data`` command) and upserts every reference table —
counting systems, qiraat, suras and per-counting-system aya counts — by its
natural key. This bootstraps a fresh/test DB (including the qiraat the mushaf
picker needs) and never clobbers existing rows.
"""

import json
from pathlib import Path

from api.models import CountingSystem, Qiraa, Sura, SuraAyaCount

DEFAULT_QIRAA = "hafs"

# The committed reference-data snapshot, co-located with the app. Regenerate it
# with ``python manage.py export_reference_data`` after editing the reference
# tables in the DB.
REFERENCE_DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "reference_data.json"


def list_suras(qiraa: str = DEFAULT_QIRAA) -> list[dict]:
    """List the 114 suras with aya counts for the given qiraa's counting system.

    Qiraa lookup is case-insensitive; ``aya_count`` is ``None`` when no count is
    stored (or the qiraa / its counting system is missing).
    """
    qiraa_obj = Qiraa.objects.select_related("counting_system").filter(name__iexact=qiraa).first()
    counting_system = qiraa_obj.counting_system if qiraa_obj else None
    counts: dict[int, int] = {}
    if counting_system is not None:
        counts = dict(SuraAyaCount.objects.filter(counting_system=counting_system).values_list("sura_id", "count"))
    return [
        {
            "number": sura.number,
            "name_arabic": sura.name_arabic,
            "transliteration": sura.transliteration,
            "aya_count": counts.get(sura.number),
        }
        for sura in Sura.objects.order_by("number")
    ]


def seed_reference_data() -> None:
    """Idempotently seed counting systems, qiraat, suras and per-system aya counts.

    Every row is matched by its natural key (counting systems and qiraat by
    ``name``, suras by ``number``), so re-running is safe and existing rows keep
    their identity.
    """
    data = json.loads(REFERENCE_DATA_PATH.read_text(encoding="utf-8"))

    systems_by_name: dict[str, CountingSystem] = {}
    for row in data["counting_systems"]:
        system, _ = CountingSystem.objects.update_or_create(
            name=row["name"], defaults={"name_arabic": row["name_arabic"]}
        )
        systems_by_name[system.name] = system

    for row in data["suras"]:
        Sura.objects.update_or_create(
            number=row["number"],
            defaults={"name_arabic": row["name_arabic"], "transliteration": row["transliteration"]},
        )

    for row in data["qiraat"]:
        Qiraa.objects.update_or_create(
            name=row["name"],
            defaults={
                "name_arabic": row["name_arabic"],
                "description": row.get("description", ""),
                "counting_system": systems_by_name.get(row["counting_system"]),
            },
        )

    for row in data["aya_counts"]:
        cs = systems_by_name.get(row["counting_system"])
        if cs is None:
            continue
        SuraAyaCount.objects.update_or_create(
            sura_id=row["sura"], counting_system=cs, defaults={"count": row["count"]}
        )

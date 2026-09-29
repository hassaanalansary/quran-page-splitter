"""Reference-data services: sura listing and reference-data seeding.

Seeding reads a single ``reference_data.json`` (exported from a filled DB via the
``export_reference_data`` command) and upserts every reference table — counting
systems, qiraat, rawis, suras and per-counting-system aya counts — by its natural
key. This bootstraps a fresh/test DB (including the rawis the mushaf picker needs)
and never clobbers existing rows.

It does **not** fill ``Word`` or ``Aya``; those come from the Quran text and the
boundary seed, and ``manage.py seed_quran`` does both in the right order.
"""

import json
from pathlib import Path

from quran.models import CountingSystem, Qiraa, Rawi, Sura, SuraAyaCount

#: The rawi a mushaf gets when none is chosen. A wire value: it names a row in the
#: rawi table, not a qiraa.
DEFAULT_QIRAA = "hafs"

# The committed reference-data snapshot, co-located with the app. Regenerate it
# with ``python manage.py export_reference_data`` after editing the reference
# tables in the DB.
REFERENCE_DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "reference_data.json"


def list_suras(qiraa: str = DEFAULT_QIRAA) -> list[dict]:
    """List the 114 suras with aya counts for the given rawi's counting system.

    ``qiraa`` is the wire name for a rawi (``"hafs"``, ``"warsh"``); lookup is
    case-insensitive. ``aya_count`` is ``None`` when no count is stored (or the
    rawi, its qiraa, or that qiraa's counting system is missing).
    """
    rawi = Rawi.objects.select_related("qiraa__counting_system").filter(name__iexact=qiraa).first()
    counting_system = rawi.counting_system if rawi else None
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
    """Idempotently seed counting systems, qiraat, rawis, suras and per-system aya counts.

    Every row is matched by its natural key (counting systems, qiraat and rawis by
    ``name``, suras by ``number``), so re-running is safe and existing rows keep
    their identity — which matters for rawis, whose names are stored on mushafs
    and inside exported work bundles.
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

    qiraat_by_name: dict[str, Qiraa] = {}
    for row in data["qiraat"]:
        qiraa, _ = Qiraa.objects.update_or_create(
            name=row["name"],
            defaults={
                "name_arabic": row["name_arabic"],
                "description": row.get("description", ""),
                "counting_system": systems_by_name.get(row["counting_system"]),
            },
        )
        qiraat_by_name[qiraa.name] = qiraa

    for row in data["rawis"]:
        Rawi.objects.update_or_create(
            name=row["name"],
            defaults={
                "name_arabic": row["name_arabic"],
                "description": row.get("description", ""),
                "qiraa": qiraat_by_name.get(row["qiraa"]),
            },
        )

    for row in data["aya_counts"]:
        cs = systems_by_name.get(row["counting_system"])
        if cs is None:
            continue
        SuraAyaCount.objects.update_or_create(sura_id=row["sura"], counting_system=cs, defaults={"count": row["count"]})

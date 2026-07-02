"""Reference-data services: sura listing and aya-count seeding.

Counting systems and qiraat are managed elsewhere (already in the DB). This
module seeds sura names (from ``core.quran_metadata``) and the per-counting-system
aya counts (from ``aya_count_per_path.json`` at the repo root), and lists suras
with the aya counts of a qiraa's counting system.
"""

import json

from django.conf import settings

from api.models import CountingSystem, Qiraa, Sura, SuraAyaCount
from core.quran_metadata import SURAS

DEFAULT_QIRAA = "hafs"

# Maps the counting-system slug used in aya_count_per_path.json to the Arabic
# name of the matching CountingSystem row (the stable join key across naming).
COUNTING_SYSTEM_BY_SLUG = {
    "madani-first": "المدني الأول",
    "madani-last": "المدني الأخير",
    "makki": "المكي",
    "basri": "البصري",
    "dimashqi": "الدمشقي",
    "kufi": "الكوفي",
}

_AYA_COUNTS_PATH = settings.BASE_DIR.parent / "aya_count_per_path.json"


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
    """Idempotently seed sura names and per-counting-system aya counts.

    Counting systems / qiraat are assumed to already exist; aya counts are matched
    to them by Arabic name. Missing counting systems are skipped.
    """
    for entry in SURAS:
        Sura.objects.update_or_create(
            number=entry.number,
            defaults={"name_arabic": entry.name, "transliteration": entry.transliteration},
        )

    # Counting systems are matched (and bootstrapped on a fresh DB) by Arabic name,
    # so an existing row keeps whatever ``name`` it already has.
    systems_by_slug = {
        slug: CountingSystem.objects.get_or_create(name_arabic=name_arabic, defaults={"name": slug})[0]
        for slug, name_arabic in COUNTING_SYSTEM_BY_SLUG.items()
    }

    rows = json.loads(_AYA_COUNTS_PATH.read_text(encoding="utf-8"))
    for row in rows:
        sura_number = row["sura"]
        for slug, count in row["counts"].items():
            system = systems_by_slug.get(slug)
            if system is not None:
                SuraAyaCount.objects.update_or_create(
                    sura_id=sura_number, counting_system=system, defaults={"count": count}
                )

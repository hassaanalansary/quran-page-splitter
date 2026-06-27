"""Reference-data services: sura listing and one-time seeding.

The canonical sura list and per-qiraa aya counts are sourced from
``core.quran_metadata.SURAS`` (the Hafs/Kufan counts) and stored in the
``Sura`` / ``SuraAyaCount`` tables.
"""

from api.models import Qiraa, Sura, SuraAyaCount
from core.quran_metadata import SURAS

DEFAULT_QIRAA = "hafs"


def list_suras(qiraa: str = DEFAULT_QIRAA) -> list[dict]:
    """Return the 114 canonical suras with the given qiraa's aya counts.

    ``aya_count`` is ``None`` for suras with no count stored for that qiraa.
    """
    counts = dict(
        SuraAyaCount.objects.filter(qiraa__name=qiraa).values_list("sura_id", "count")
    )
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
    """Idempotently seed qiraat, suras, and per-qiraa aya counts from core metadata."""
    qiraa, _ = Qiraa.objects.get_or_create(
        name=DEFAULT_QIRAA, defaults={"description": "Hafs an Asim"}
    )
    for entry in SURAS:
        sura, _ = Sura.objects.update_or_create(
            number=entry.number,
            defaults={
                "name_arabic": entry.name,
                "transliteration": entry.transliteration,
            },
        )
        SuraAyaCount.objects.update_or_create(
            sura=sura, qiraa=qiraa, defaults={"count": entry.aya_count}
        )

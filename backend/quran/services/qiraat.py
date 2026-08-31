"""Qiraa reference-data service (list the recitations for the mushaf picker).

What the picker offers is the twenty **rawis** — Hafs, Warsh, Qalun — because that
is what a mushaf is printed in. The wire has always called them "qiraat" and still
does: ``{name, counting_system}`` where ``name`` is the rawi's, which is the value
stored on a mushaf and inside exported bundles. ``qiraa`` is additive, naming the
recitation the rawi transmits.

See ``services.suras`` for the sura/aya-count side.
"""

from django.db.models.functions import Lower

from quran.models import CountingSystem, Rawi


def list_qiraat(lang: str | None = None) -> list[dict]:
    """List every rawi as ``{name, qiraa, counting_system}``, ordered case-insensitively by name."""
    arabic = lang == "ar"
    return [
        {
            "name": rawi.name_arabic if arabic else rawi.name,
            "qiraa": _qiraa_label(rawi, arabic),
            "counting_system": _system_label(rawi.counting_system, arabic),
        }
        for rawi in Rawi.objects.select_related("qiraa__counting_system").order_by(Lower("name"))
    ]


def _qiraa_label(rawi: Rawi, arabic: bool) -> str:
    """The recitation this rawi transmits, or ``""`` when it is not linked to one."""
    if rawi.qiraa is None:
        return ""
    return rawi.qiraa.name_arabic if arabic else rawi.qiraa.name


def _system_label(system: CountingSystem | None, arabic: bool) -> str:
    """Counting-system name in the requested language, or ``""`` when there is none."""
    if system is None:
        return ""
    return system.name_arabic if arabic else system.name

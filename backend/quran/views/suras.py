"""Sura reference endpoints."""

from django.http import HttpRequest
from ninja import Router, Schema

from quran.services import suras as suras_service

router = Router(tags=["suras"])


class SuraOut(Schema):
    number: int
    name_arabic: str
    transliteration: str
    aya_count: int | None = None


@router.get("", response=list[SuraOut])
def list_suras(request: HttpRequest, qiraa: str = suras_service.DEFAULT_QIRAA) -> list[dict]:
    """List canonical suras with aya counts for the given qiraa (default: hafs)."""
    return suras_service.list_suras(qiraa)

"""Qiraa reference endpoints."""

from typing import Literal

from django.http import HttpRequest
from ninja import Router, Schema

from quran.services import qiraat as qiraat_service

router = Router(tags=["qiraat"])


class QiraaOut(Schema):
    #: The rawi — Hafs, Warsh, Qalun. This is the value a mushaf stores, and the
    #: one exported bundles carry, so it keeps its long-standing wire name.
    name: str
    #: The recitation the rawi transmits. Added alongside the existing fields, so
    #: clients that never asked for it are unaffected.
    qiraa: str = ""
    counting_system: str


@router.get("", response=list[QiraaOut])
def list_qiraat(request: HttpRequest, lang: Literal["ar", "en"] | None = None) -> list[dict]:
    """List all rawis (transmitters) for the mushaf picker, with their qiraa."""
    return qiraat_service.list_qiraat(lang=lang)

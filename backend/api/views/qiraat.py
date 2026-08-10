"""Qiraa reference endpoints."""

from typing import Literal

from django.http import HttpRequest
from ninja import Router, Schema

from api.services import qiraat as qiraat_service

router = Router(tags=["qiraat"])


class QiraaOut(Schema):
    name: str
    counting_system: str


@router.get("", response=list[QiraaOut])
def list_qiraat(request: HttpRequest, lang: Literal["ar", "en"] | None = None) -> list[dict]:
    """List all qiraat (schools of recitation) for the mushaf picker."""
    return qiraat_service.list_qiraat(lang=lang)

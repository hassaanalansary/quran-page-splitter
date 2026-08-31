from django.http import HttpRequest
from ninja import Router, Schema

from quran.services import counting_system as counting_systems_service

router = Router(tags=["Counting Systems"])


class CountingSystemOut(Schema):
    name: str
    name_arabic: str


@router.get("", response=list[CountingSystemOut])
def list_counting_systems(request: HttpRequest) -> list[dict]:
    """List all counting systems for the mushaf picker."""

    return counting_systems_service.list_counting_systems()

"""A mushaf's calibration settings: how its fingerprint library compares shapes.

Local to the mushaf: never carried by a copy or an import.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from accounts.models import User
from api.models import ActivityTypeChoices, CalibrationSettings, Mushaf
from api.services import activity
from api.services.calibration_errors import refuse_request
from core.word_boundary.library import COMPARISONS, DEFAULT_COMPARISON, comparison

Doc = dict[str, Any]

#: Refused above this: a LIMIT that groups every shape together is a typo, not a setting.
LIMIT_CEILING = 10.0


def serialize_calibration_settings(mushaf: Mushaf) -> Doc:
    """The mushaf's calibration settings: the library's comparison and LIMIT (``limit``
    is what is in force; ``default_limit`` what an unset LIMIT means for that comparison)."""
    setting = CalibrationSettings.objects.filter(mushaf=mushaf).first()
    method = comparison(setting.comparison if setting else None)
    return {
        "revision": setting.revision if setting else 0,
        "comparison": method.name,
        "limit": setting.library_limit if setting and setting.library_limit is not None else method.default_limit,
        "default_limit": method.default_limit,
    }


@transaction.atomic
def save_calibration_settings(mushaf: Mushaf, data: Doc, *, user: User | None) -> Doc:
    Mushaf.objects.select_for_update().get(pk=mushaf.pk)
    setting, _ = CalibrationSettings.objects.get_or_create(mushaf=mushaf)
    if setting.revision != data["revision"]:
        refuse_request("stale_revision")
    # Every save says the whole setting: a null LIMIT is the comparison's default.
    chosen = data.get("comparison") or setting.comparison or DEFAULT_COMPARISON
    limit = data.get("limit")
    if chosen not in COMPARISONS or (limit is not None and not 0 < limit <= LIMIT_CEILING):
        refuse_request("invalid_edits", 422)
    setting.comparison = chosen
    setting.library_limit = limit
    setting.revision += 1
    setting.save(update_fields=["comparison", "library_limit", "revision", "updated_at"])
    activity.emit(
        mushaf,
        ActivityTypeChoices.CALIBRATION_SAVED,
        {"action": "settings", **serialize_calibration_settings(mushaf)},
        actor=user,
    )
    return serialize_calibration_settings(mushaf)

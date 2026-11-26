"""Applying the fingerprint library's settings: save them, and regroup the set when they
change how it groups.

    apply_library_settings
      the LIMIT or the comparison changes?  → refused while another job holds the mushaf
      save_calibration_settings             the settings themselves
      start_library_rebuild_job             the set regrouped at them, in the background

The stored set keeps serving at the old settings until the rebuild commits; Library mode
says so while it runs.
"""

from __future__ import annotations

from typing import Any

from accounts.models import User
from api.models import FingerprintLibrary, Mushaf
from api.services.calibration_settings import save_calibration_settings, serialize_calibration_settings
from api.services.jobs.admission import refuse_if_mushaf_has_active_job
from api.services.jobs.kinds.library_rebuild import start_library_rebuild_job
from core.word_boundary.library import COMPARISONS, comparison

Doc = dict[str, Any]


def apply_library_settings(mushaf: Mushaf, data: Doc, *, user: User | None) -> Doc:
    """Save the settings; when they change how the set groups, start its rebuild."""
    regroups = does_change_regroup_the_set(mushaf, data)
    if regroups:
        refuse_if_mushaf_has_active_job(mushaf.id)
    saved = save_calibration_settings(mushaf, data, user=user)
    if regroups:
        start_library_rebuild_job(mushaf, user=user)
    return saved


def does_change_regroup_the_set(mushaf: Mushaf, data: Doc) -> bool:
    """Whether saving ``data`` changes the comparison or the LIMIT the set was grouped with."""
    name = data.get("comparison") or serialize_calibration_settings(mushaf)["comparison"]
    if name not in COMPARISONS:
        return False  # refused by the save itself
    chosen = comparison(name)
    limit = data["limit"] if data.get("limit") is not None else chosen.default_limit
    library_row = FingerprintLibrary.objects.filter(mushaf=mushaf).first()
    if library_row is None or not library_row.version:
        return False
    return (chosen.name, limit) != (library_row.comparison, library_row.limit)

"""Restarting a mushaf's calibration from a real zero, backup first.

``manage.py restart_calibration`` is the only caller; never an ordinary job::

    back_up_calibration         the whole mushaf as a bundle, to a new file
    delete_calibration_labels   every review and revision, the fingerprint set, its
                                looks-right marks and removed list, and the words the
                                pages' confirmations wrote

Kept: the line snapshots (measurements of the page images with no labels in them, which
processing would make again identically), the calibration settings, and the activity
log. A walkthrough after a restart starts with nothing learned, so it is not shaped by
any run before it.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from accounts.models import User
from api.models import (
    ActivityTypeChoices,
    CalibrationReview,
    FingerprintLibrary,
    LineWord,
    Mushaf,
    RemovedShape,
)
from api.services import activity, bundle


def list_pages_to_restart(mushaf: Mushaf) -> list[CalibrationReview]:
    """The pages a restart changes: processed or confirmed, in page order."""
    return [
        review
        for review in CalibrationReview.objects.select_for_update().filter(mushaf=mushaf).order_by("page_number")
        if review.payload.get("lines") or review.confirmed_revision is not None
    ]


def back_up_calibration(mushaf: Mushaf, backup: Path) -> None:
    """The mushaf as a bundle, written to ``backup``. Never over an existing file: a
    prior recovery point is never lost. Raises ``OSError`` when it cannot be written."""
    _, archive = bundle.build_mushaf_bundle(mushaf.id, user=mushaf.owner)
    try:
        with backup.open("xb") as output:
            archive.seek(0)
            shutil.copyfileobj(archive, output)
    finally:
        archive.close()


def delete_calibration_labels(mushaf: Mushaf, pages: list[CalibrationReview], *, user: User | None) -> None:
    """Everything calibration learned on the mushaf, gone; the snapshots, settings and
    activity log stay."""
    for review in pages:
        LineWord.objects.filter(line__page__mushaf=mushaf, line__page__page_number=review.page_number).delete()
        activity.emit(
            mushaf,
            ActivityTypeChoices.CALIBRATION_SAVED,
            {"page_number": review.page_number, "action": "restart", "revision": review.revision},
            actor=user,
        )
    CalibrationReview.objects.filter(mushaf=mushaf).delete()
    FingerprintLibrary.objects.filter(mushaf=mushaf).delete()
    RemovedShape.objects.filter(mushaf=mushaf).delete()

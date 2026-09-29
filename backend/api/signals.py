"""Model signals — one, and it exists because of a cascade.

Re-processing a page deletes its ``Line`` rows, and every ``LineWord`` goes with
them. For an engine-written line that is the point: the words are stale. For a line
a person made — corrected in the word editor, or confirmed in calibration — it would
silently destroy their work, so its boundaries are archived into the page's
calibration review first (``word_coordinates.HAND_MADE`` says which lines).

A signal rather than a call in the processing service, because a ``Line`` is deleted
from several places — detection, a bundle imported over existing pages — and the one
place they all pass through is the deletion itself.
"""

from typing import Any

from django.db.models.signals import pre_delete
from django.dispatch import receiver

from api.models import Line, Page


@receiver(pre_delete, sender=Line)
def preserve_edited_line_boundaries(sender: type[Line], instance: Line, using: str, origin: Any, **kwargs: Any) -> None:
    # Deleting a whole mushaf or account removes its calibration history too, on
    # purpose — so only a deletion that starts at a line or a page archives.
    origin_model = getattr(origin, "model", type(origin))
    if origin_model not in (Line, Page):
        return
    from api.services.word_coordinates import HAND_MADE, preserve_legacy_edits

    if Line.objects.using(using).filter(HAND_MADE, pk=instance.pk).exists():
        preserve_legacy_edits(instance.page, using=using)

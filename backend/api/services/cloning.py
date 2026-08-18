"""Copying a mushaf's work into another account.

The expensive part of a mushaf is not its rows — it is the ~143 MB PDF and the
~700 MB of exported line PNGs. So a duplicate copies neither:

* the **PDF** is shared by assigning ``FileField.name``. That column stores a
  *path*, not the bytes, so two rows can address one file and the copy costs
  zero storage. ``mushaf._delete_if_unshared`` is what keeps that safe when one
  of them is later deleted. It is the one file that lives outside the mushaf's
  own directory, in the content-addressed ``pdfs/`` store.
* the **thumbnail and template crops** are copied for real. They are a few KB
  each and belong inside ``mushafs/<id>/``, so the new owner's directory is
  self-contained and their edits never reach back into the source.
* the **exported line PNGs** are skipped entirely. They are derived output; the
  new owner re-exports whenever they want them.

What does get copied is the part a human paid for: page bounds, line and segment
geometry, sura assignments and erase strokes.
"""

import logging
import uuid

from django.core.files.base import ContentFile
from django.db import transaction

from accounts.models import User
from api.models import (
    ActivityTypeChoices,
    Mushaf,
    Template,
    VisibilityChoices,
)
from api.services import activity, bundle
from api.services import mushaf as mushaf_service

logger = logging.getLogger(__name__)


def _unique_name(owner: User, name: str) -> str:
    """A name free within this owner's collection.

    Names are unique per owner, so duplicating a mushaf you already have a name
    clash with needs a suffix: "Madinah" -> "Madinah (copy)" -> "Madinah (copy 2)".
    """
    taken = set(Mushaf.objects.filter(owner=owner).values_list("name", flat=True))
    if name not in taken:
        return name
    candidate = f"{name} (copy)"
    counter = 2
    while candidate in taken:
        candidate = f"{name} (copy {counter})"
        counter += 1
    return candidate[:256]


def _copy_templates(source: Mushaf, target: Mushaf) -> None:
    """Copy template crops as real files, unlike the PDF.

    They are small (a few hundred KB), and the new owner will redraw them — an
    edit must not reach back into the mushaf they copied from.
    """
    for template in source.templates.all():
        copy = Template(mushaf=target, type=template.type, ignore_rects=template.ignore_rects)
        if template.image:
            try:
                template.image.open("rb")
                copy.image.save(f"{template.type}.png", ContentFile(template.image.read()), save=False)
            except (OSError, ValueError):
                # A missing template file must not sink the whole duplication;
                # the new owner can just redraw it.
                logger.warning("Template image %s missing; copied without it", template.image.name)
            finally:
                template.image.close()
        copy.save()


def _copy_tree(source: Mushaf, target: Mushaf) -> None:
    """Copy the page -> line -> segment/stroke tree.

    Routed through the bundle format's own (de)serializers so that duplicating a
    mushaf and importing a bundle write rows through one implementation. Two
    hand-written tree copies would eventually disagree about some field, and the
    symptom would be silently wrong geometry.
    """
    bundle.write_tree(target, bundle.serialize_tree(source))


def duplicate(source: Mushaf, *, owner: User) -> Mushaf:
    """Copy ``source`` into ``owner``'s account and return the new mushaf.

    Synchronous on purpose: ~23k rows through ``bulk_create`` is a few seconds,
    and no bytes are copied, so there is nothing here worth a background job.
    """
    with transaction.atomic():
        target = Mushaf(
            owner=owner,
            name=_unique_name(owner, source.name),
            qiraa=source.qiraa,
            pdf_original_name=source.pdf_original_name,
            pdf_sha256=source.pdf_sha256,
            pdf_page_count=source.pdf_page_count,
            first_quran_pdf_page=source.first_quran_pdf_page,
            last_quran_pdf_page=source.last_quran_pdf_page,
            description=source.description,
            # A copy starts private; publishing it again is the new owner's call.
            visibility=VisibilityChoices.PRIVATE,
            duplicated_from=source,
        )
        # Assigning `.name` records the same path. Calling `.save()` on the field
        # would copy ~143 MB of PDF instead — that difference is the whole point.
        target.pdf_file.name = source.pdf_file.name
        target.save()

        # The cover, unlike the PDF, *is* copied: it lives inside the mushaf's
        # own media directory, and it is only a few KB.
        mushaf_service._copy_thumbnail_from(source, target)
        _copy_templates(source, target)
        _copy_tree(source, target)

        activity.emit(
            target,
            ActivityTypeChoices.MUSHAF_CREATED,
            {
                "duplicated_from": str(source.id),
                "duplicated_from_name": source.name,
                "pdf_original_name": target.pdf_original_name,
            },
            actor=owner,
        )

    logger.info("Duplicated mushaf %s into %s for %s", source.id, target.id, owner.pk)
    return target


def duplicate_by_id(source_id: uuid.UUID, *, owner: User) -> Mushaf:
    """Duplicate a *published* mushaf (or one you already own) by id."""
    source = mushaf_service.get_mushaf(source_id, user=owner, write=False)
    return duplicate(source, owner=owner)

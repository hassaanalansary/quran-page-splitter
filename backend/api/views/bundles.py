# ruff: noqa: B008  -- Ninja's File() is meant to be used in a parameter default
"""Identifying a work bundle before it is applied.

Applying a bundle belongs to the mushaf it targets (``/mushafs/{id}/import``).
This router is the step before that: it answers "which mushaf is this zip's
work from?" so nobody has to recognise a sha256 by eye to find out.
"""

from django.http import HttpRequest
from ninja import File, Router, Schema
from ninja.files import UploadedFile

from api.auth import current_user
from api.services import bundle as bundle_service
from api.views.mushafs import MushafOut

router = Router(tags=["bundles"])


class BundleSourceOut(Schema):
    """What the bundle says about itself — read from its manifest, not the DB."""

    name: str = ""
    qiraa: str | None = None
    pdf_sha256: str = ""
    pdf_original_name: str = ""
    pdf_page_count: int = 0
    first_quran_pdf_page: int = 1
    last_quran_pdf_page: int | None = None
    exported_at: str = ""
    pages: int = 0
    lines: int = 0
    segments: int = 0


class BundleMatchOut(MushafOut):
    """A candidate target: one of the caller's mushafs built from the same PDF.

    Carries the mushaf's own page counts (so the dialog can say what an import
    would overwrite) plus how the bundle's setup diverges from it.
    """

    bounds_differ: bool = False
    page_count_differs: bool = False


class InspectOut(Schema):
    bundle: BundleSourceOut
    matches: list[BundleMatchOut]


@router.post("/inspect", response=InspectOut)
def inspect_bundle(request: HttpRequest, file: UploadedFile = File(...)) -> dict:
    """Read a bundle's manifest and list the caller's mushafs it could go into.

    Read-only, and never the last word: whichever match the user approves, the
    import re-checks the PDF hash before writing anything.
    """
    return bundle_service.inspect_bundle(file, user=current_user(request))

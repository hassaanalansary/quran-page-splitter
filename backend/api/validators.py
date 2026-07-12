"""Shared validation helpers, called from services. Raise Ninja HttpError on failure."""

from ninja.errors import HttpError

from api import i18n
from api.models import Mushaf


def logical_page_count(mushaf: Mushaf) -> int:
    """Number of logical Quran pages bounded by the mushaf's first/last Quran PDF pages."""
    return mushaf.last_quran_pdf_page - mushaf.first_quran_pdf_page + 1


def validate_pdf_bounds(first_quran_pdf_page: int, last_quran_pdf_page: int, pdf_page_count: int) -> None:
    """Ensure 1 <= first <= last <= total physical pages."""
    if not 1 <= first_quran_pdf_page <= last_quran_pdf_page <= pdf_page_count:
        raise HttpError(
            400,
            i18n.t(
                "pdf_bounds",
                max=pdf_page_count,
                first=first_quran_pdf_page,
                last=last_quran_pdf_page,
            ),
        )


def validate_page_number(mushaf: Mushaf, page_number: int) -> None:
    """Ensure a logical page number is within the mushaf's content bounds."""
    count = logical_page_count(mushaf)
    if not 1 <= page_number <= count:
        raise HttpError(404, i18n.t("page_number_range", count=count, page_number=page_number))


def validate_page_range(mushaf: Mushaf, start: int, end: int) -> None:
    """Ensure a processing range is ordered and within the mushaf's content bounds."""
    count = logical_page_count(mushaf)
    if not 1 <= start <= end <= count:
        raise HttpError(400, i18n.t("page_range", count=count, start=start, end=end))

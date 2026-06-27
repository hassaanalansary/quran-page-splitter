"""Shared validation helpers, called from services. Raise Ninja HttpError on failure."""

from ninja.errors import HttpError

from api.models import Mushaf


def logical_page_count(mushaf: Mushaf) -> int:
    """Number of logical Quran pages bounded by the mushaf's first/last Quran PDF pages."""
    return mushaf.last_quran_pdf_page - mushaf.first_quran_pdf_page + 1


def validate_pdf_bounds(first_quran_pdf_page: int, last_quran_pdf_page: int, pdf_page_count: int) -> None:
    """Ensure 1 <= first <= last <= total physical pages."""
    if not 1 <= first_quran_pdf_page <= last_quran_pdf_page <= pdf_page_count:
        raise HttpError(
            400,
            f"Require 1 <= first_quran_pdf_page <= last_quran_pdf_page <= {pdf_page_count} "
            f"(got {first_quran_pdf_page}, {last_quran_pdf_page}).",
        )


def validate_page_number(mushaf: Mushaf, page_number: int) -> None:
    """Ensure a logical page number is within the mushaf's content bounds."""
    count = logical_page_count(mushaf)
    if not 1 <= page_number <= count:
        raise HttpError(404, f"page_number must be in 1..{count} (got {page_number}).")


def validate_page_range(mushaf: Mushaf, start: int, end: int) -> None:
    """Ensure a processing range is ordered and within the mushaf's content bounds."""
    count = logical_page_count(mushaf)
    if not 1 <= start <= end <= count:
        raise HttpError(400, f"Require 1 <= start <= end <= {count} (got {start}, {end}).")

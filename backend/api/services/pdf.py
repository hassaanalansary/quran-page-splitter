"""PDF helpers: hashing, page count, single-page rendering.

Pure functions — no ORM, no Django models. Page images are always rendered
on demand from the stored PDF (nothing is cached in the database).
"""

import hashlib

import fitz  # PyMuPDF

DEFAULT_DPI = 300


def sha256_of(data: bytes) -> str:
    """SHA-256 hex digest of the given bytes."""
    return hashlib.sha256(data).hexdigest()


def page_count(data: bytes) -> int:
    """Number of physical pages in a PDF given its raw bytes."""
    with fitz.open(stream=data, filetype="pdf") as doc:
        return int(doc.page_count)


def render_page(pdf_path: str, pdf_index: int, dpi: int = DEFAULT_DPI) -> bytes:
    """Render one PDF page (1-based physical index) to PNG bytes."""
    zoom = dpi / 72.0  # PDF default resolution is 72 dpi
    matrix = fitz.Matrix(zoom, zoom)
    with fitz.open(pdf_path) as doc:
        pixmap = doc.load_page(pdf_index - 1).get_pixmap(matrix=matrix)
        return bytes(pixmap.tobytes("png"))


def logical_to_pdf_index(
    first_quran_pdf_page: int, page_number: int, source_pdf_page: int | None = None
) -> int:
    """Map a logical Quran page to its physical PDF index.

    ``source_pdf_page`` overrides the offset rule when set (the per-page escape hatch).
    """
    if source_pdf_page is not None:
        return source_pdf_page
    return first_quran_pdf_page + page_number - 1

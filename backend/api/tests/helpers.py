"""Shared test helpers: tiny PDF/PNG builders and media/auth-aware TestCases."""

from __future__ import annotations

import io
import tempfile
from typing import Any

import fitz  # PyMuPDF
from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase, override_settings
from PIL import Image

from api.models import Mushaf


def make_pdf_bytes(num_pages: int = 1) -> bytes:
    """Build a minimal in-memory PDF with the given number of pages."""
    doc = fitz.open()
    for i in range(num_pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Page {i + 1}")
    data: bytes = doc.tobytes()
    doc.close()
    return data


def make_png_bytes(size: tuple[int, int] = (20, 20)) -> bytes:
    """Build a tiny white PNG used as a stand-in template crop."""
    buffer = io.BytesIO()
    Image.new("RGB", size, (255, 255, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


class _MediaIsolation:
    """Points MEDIA_ROOT at a throwaway directory for the life of the class."""

    _media_dir: tempfile.TemporaryDirectory[str]
    _media_override: override_settings

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()  # type: ignore[misc]
        cls._media_dir = tempfile.TemporaryDirectory()
        cls._media_override = override_settings(MEDIA_ROOT=cls._media_dir.name)
        cls._media_override.enable()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._media_override.disable()
        cls._media_dir.cleanup()
        super().tearDownClass()  # type: ignore[misc]


class MediaTestCase(_MediaIsolation, TestCase):
    """TestCase that isolates uploaded files into a throwaway MEDIA_ROOT."""


class MediaTransactionTestCase(_MediaIsolation, TransactionTestCase):
    """Same isolation, but **without** wrapping each test in a transaction.

    Needed by anything that starts a real worker thread. A plain ``TestCase``
    keeps its writes inside an uncommitted transaction, which a second thread
    (on its own connection) cannot see — so a worker would look up its own
    ``ProcessJob`` row and find nothing. Now that job state lives in the
    database rather than a module-level dict, that matters.

    Slower: tables are truncated between tests instead of rolled back.
    """


TEST_USER_EMAIL = "tester@example.com"


def make_user(email: str = TEST_USER_EMAIL, **extra: Any):
    """A persisted account, addressed by email (there is no username field)."""
    return get_user_model().objects.create_user(email=email, password="pw", **extra)


def default_user():
    """The test account, get-or-create.

    Module-level fixture helpers build mushafs through the service layer, while
    ``ApiTestCase`` drives the same mushafs over HTTP. Both must land on **one**
    owner — otherwise a fixture built by a helper would 404 for the signed-in
    client, since mushafs are now scoped to their owner.
    """
    model = get_user_model()
    return model.objects.filter(email=TEST_USER_EMAIL).first() or make_user()


class ApiTestCase(MediaTestCase):
    """MediaTestCase with a signed-in client.

    Every ``/api`` route except the reference-data ones (counting-systems,
    qiraat, suras) is behind ``django_auth``, so tests driving the HTTP layer
    need a session. **Subclasses that define ``setUp`` must call
    ``super().setUp()``** or they will get 401s.
    """

    def setUp(self) -> None:
        super().setUp()
        self.user = default_user()
        self.client.force_login(self.user)


def bare_mushaf(name: str = "M", last_quran_pdf_page: int = 10, owner: Any = None) -> Mushaf:
    """A persisted Mushaf with no real PDF file (for tests that don't render)."""
    return Mushaf.objects.create(
        owner=owner or default_user(),
        name=name,
        pdf_sha256="x",
        pdf_page_count=last_quran_pdf_page,
        first_quran_pdf_page=1,
        last_quran_pdf_page=last_quran_pdf_page,
    )

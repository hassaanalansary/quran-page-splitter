"""Shared test helpers: tiny PDF/PNG builders and media/auth-aware TestCases."""

from __future__ import annotations

import io
import tempfile
from pathlib import Path
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


class _FilesystemIsolation:
    """Points MEDIA_ROOT and LOG_DIR at throwaway directories for the class.

    MEDIA_ROOT keeps uploads out of the working tree. LOG_DIR matters for a
    different reason: starting a run **prunes** the run-log directory down to
    ``RUN_LOG_RETENTION`` (see ``services.run_logs.allocate``), so a test that
    drives a real run would otherwise delete the developer's own recent logs —
    quietly, and exactly the ones they had just been reading.
    """

    _media_dir: tempfile.TemporaryDirectory[str]
    _log_dir: tempfile.TemporaryDirectory[str]
    _fs_override: override_settings

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()  # type: ignore[misc]
        # ``ignore_cleanup_errors`` because Windows refuses to unlink a file that is
        # still open, and a streamed response the test client never closed leaves one.
        # Without it a single leaked handle fails tearDownClass, which on a Django
        # TestCase leaves the connection broken and errors every test after it — a
        # cascade with nothing in it about the thing that actually went wrong.
        cls._media_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls._log_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls._fs_override = override_settings(MEDIA_ROOT=cls._media_dir.name, LOG_DIR=Path(cls._log_dir.name))
        cls._fs_override.enable()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._fs_override.disable()
        cls._media_dir.cleanup()
        cls._log_dir.cleanup()
        super().tearDownClass()  # type: ignore[misc]


class MediaTestCase(_FilesystemIsolation, TestCase):
    """TestCase that isolates uploaded files and run logs into throwaway directories."""


class MediaTransactionTestCase(_FilesystemIsolation, TransactionTestCase):
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

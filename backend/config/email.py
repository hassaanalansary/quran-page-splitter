"""A development email backend you can actually copy links out of.

Django's stock console backend prints the raw MIME message. Django encodes
utf-8 bodies as quoted-printable, which soft-wraps at 76 columns and marks each
continuation with a trailing ``=``::

    http://localhost:5173/auth/reset/37dc2f030d914f1c8953f21a941fd378-ddhb5c-8036=
    d273f909e399f994704413945392

A mail client strips that invisibly, so the delivered email is correct — but in
a terminal it splits every verification and password-reset link in two, and the
halves cannot be pasted back together without knowing that the ``=`` is an
artifact. Since those links are the whole reason to run a console backend, this
subclass decodes each part before printing it.
"""

from typing import Any

from django.core.mail.backends.console import EmailBackend as ConsoleEmailBackend

RULE = "=" * 78


class ReadableConsoleEmailBackend(ConsoleEmailBackend):
    """Console backend that prints decoded text instead of raw MIME."""

    def write_message(self, message: Any) -> None:
        mime = message.message()

        self.stream.write(f"\n{RULE}\n")
        for header in ("Subject", "From", "To", "Date"):
            value = mime.get(header)
            if value:
                self.stream.write(f"{header}: {value}\n")
        self.stream.write(f"{'-' * 78}\n")

        for part in mime.walk():
            if part.get_content_maintype() != "text":
                continue
            # decode=True undoes the transfer encoding, which is what rejoins
            # the soft-wrapped lines.
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            self.stream.write(payload.decode(charset, errors="replace").rstrip())
            self.stream.write("\n")

        self.stream.write(f"{RULE}\n")
        self.stream.flush()

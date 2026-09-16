"""The shared log file, and what happens when it cannot be rotated.

Lives beside the run-log tests rather than under ``config`` because it guards the
same thing they do: that a long engine run can write its trace without the logging
stack becoming the reason the run dies.

The failure this pins is not hypothetical. A word run was seen to hang with the
browser reporting a dead engine, and the cause was a rollover Windows refused —
``quran.log`` pinned nineteen bytes under its 5 MB limit, a ``quran.log.3`` with no
``.1`` or ``.2`` beside it, and a traceback on stderr for every record the engine
emitted. See ``config.logging_handlers.SharedRotatingFileHandler``.
"""

import io
import logging
import sys
import tempfile
from logging.handlers import RotatingFileHandler
from pathlib import Path

from django.test import SimpleTestCase

from config.logging_handlers import SharedRotatingFileHandler


class BlockedRolloverTests(SimpleTestCase):
    """A second open handle is the whole condition — that is what a second worker is.

    ``SimpleTestCase``: none of this touches the database, and the handler is
    driven directly rather than through ``settings.LOGGING`` so the test says what
    the handler does, not what this project happens to configure.
    """

    RECORDS = 50

    def _drive(self, handler_class: type[logging.Handler], name: str) -> tuple[str, int]:
        """Emit records over a rollover boundary while something else holds the file.

        Returns what reached stderr and how many records actually landed in the
        log — the two numbers that separate a delay from a fault.
        """
        directory = Path(tempfile.mkdtemp())
        path = directory / f"{name}.log"

        handler = handler_class(str(path), maxBytes=400, backupCount=2, encoding="utf-8")  # type: ignore[call-arg]
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = logging.getLogger(f"test.blocked.{name}")
        logger.handlers = [handler]
        logger.propagate = False
        logger.setLevel(logging.DEBUG)
        self.addCleanup(handler.close)
        self.addCleanup(lambda: setattr(logger, "handlers", []))

        # Push the file past maxBytes so the next record wants a rollover.
        logger.info("x" * 500)

        blocker = path.open("rb")  # the other process
        captured = io.StringIO()
        real_stderr, sys.stderr = sys.stderr, captured
        try:
            for index in range(self.RECORDS):
                logger.info("record %d %s", index, "y" * 40)
        finally:
            sys.stderr = real_stderr
            blocker.close()

        kept = sum(
            1 for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.startswith("record ")
        )
        return captured.getvalue(), kept

    def test_the_stock_handler_loses_every_record_and_says_so_every_time(self):
        """Pins *why* this subclass exists, so nobody reverts it as ceremony.

        The stock handler does not degrade — it fails completely, per record, for
        as long as the other holder lives.
        """
        noise, kept = self._drive(RotatingFileHandler, "stock")
        self.assertEqual(kept, 0)
        self.assertEqual(noise.count("Traceback (most recent call last)"), self.RECORDS)

    def test_a_blocked_rollover_keeps_the_records_and_reports_once(self):
        noise, kept = self._drive(SharedRotatingFileHandler, "shared")
        # Nothing is lost: the file simply runs over its limit until it can rotate.
        self.assertEqual(kept, self.RECORDS)
        self.assertNotIn("Traceback", noise)
        # One line for the whole blocked period. The per-record traceback storm is
        # the actual cost being avoided here, not the exception itself.
        self.assertEqual(len(noise.splitlines()), 1)
        self.assertIn("cannot rotate", noise)

    def test_rotation_resumes_once_the_other_holder_lets_go(self):
        """The cooldown is a delay, not a surrender — or the file grows forever."""
        directory = Path(tempfile.mkdtemp())
        path = directory / "resume.log"
        handler = SharedRotatingFileHandler(str(path), maxBytes=400, backupCount=2, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        self.addCleanup(handler.close)

        record = logging.LogRecord("t", logging.INFO, __file__, 1, "z" * 500, None, None)
        handler.emit(record)

        blocker = path.open("rb")
        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            handler.emit(record)
        finally:
            sys.stderr = stderr
        self.assertTrue(handler._retry_at, "a blocked rollover should start a cooldown")

        blocker.close()
        # Time is not waited for: the cooldown exists to stop a retry per record,
        # and what matters is that clearing it lets the next record rotate.
        handler._retry_at = 0.0
        handler.emit(record)
        self.assertFalse(handler._retry_at, "rotation should resume once it succeeds")
        self.assertTrue((directory / "resume.log.1").exists())

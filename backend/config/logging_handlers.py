"""Log handlers referenced by the ``LOGGING`` dict in settings."""

from __future__ import annotations

import sys
import time
from logging import LogRecord
from logging.handlers import RotatingFileHandler


class SharedRotatingFileHandler(RotatingFileHandler):
    """A rotating handler for a file more than one process may hold open.

    On Windows a rollover is ``os.rename``, and a rename fails outright while any
    other handle is open on the file. More than one process holding it is the
    normal case, not an exotic one: ``manage.py runserver`` runs an autoreload
    parent *and* a child, and any multi-worker server runs several.

    The stock handler turns that single failed rename into a permanent fault.
    ``doRollover`` raises, ``handleError`` prints a traceback and swallows it, and
    nothing was truncated — so the file is **still** over ``maxBytes`` and the very
    next record tries the whole thing again. Every record from then on costs a
    stream close, a failed rename, a multi-frame traceback on stderr and a reopen.
    A word run emitting thousands of records a line slows to the point where its
    job stops sending heartbeats and is settled as ``interrupted``, which reads
    from the browser as the engine having died.

    Observed exactly that way: ``quran.log`` pinned at 5,242,861 bytes against a
    5,242,880 limit — nineteen bytes short, unable to grow, retrying forever — with
    a ``quran.log.3`` present and no ``.1`` or ``.2``, the signature of a rename
    that never completed.

    So here a blocked rollover is a **delay, not a fault**: keep appending to the
    file we already have, and stop asking for a while. The log runs over its limit
    for one cooldown, which is a far smaller problem than the one it replaces, and
    rotation resumes on its own as soon as the other holder lets go.
    """

    #: Seconds to keep appending before trying a blocked rollover again. Long
    #: enough that a busy run is not re-attempting it every few records; short
    #: enough that the file is trimmed soon after the other process exits.
    retry_after = 60.0

    #: Class-level so the attribute exists however the handler is constructed —
    #: ``logging.config`` builds these by keyword and a subclass is easy to get
    #: wrong. Zero means "not blocked".
    _retry_at = 0.0

    def shouldRollover(self, record: LogRecord) -> bool:
        """Skip the size check entirely while a rollover is known to be blocked.

        This is the half that matters. Catching the error without this would still
        attempt — and fail — a rename on every single record, which is the actual
        cost, not the exception itself.
        """
        if self._retry_at and time.monotonic() < self._retry_at:
            return False
        return bool(super().shouldRollover(record))

    def doRollover(self) -> None:
        try:
            super().doRollover()
        except OSError as error:
            first = not self._retry_at
            self._retry_at = time.monotonic() + self.retry_after
            # ``RotatingFileHandler.doRollover`` closes the stream *before* it
            # renames and only reopens at the very end, so the raise leaves this
            # handler with no stream at all.
            if self.stream is None and not self.delay:
                self.stream = self._open()
            if first:
                # Straight to stderr, once per blocked period: going through
                # ``logging`` here would re-enter this handler, and
                # ``handleError`` would print the traceback this exists to avoid.
                sys.stderr.write(
                    f"{type(self).__name__}: cannot rotate {self.baseFilename} "
                    f"({error}); appending past the size limit and retrying in "
                    f"{self.retry_after:.0f}s\n"
                )
        else:
            self._retry_at = 0.0

"""Logging filters referenced by the ``LOGGING`` dict in settings."""

import logging


class QuietEngineTrace(logging.Filter):
    """Keep the ``core.*`` detection trace off the console.

    The engine logs a few hundred lines per page — every band, line, segment and
    aya. In a terminal that buries the request log; the useful place to read it
    is the per-run file (and the in-app log viewer that tails it).

    Only INFO and DEBUG are dropped: a warning or an error from the engine still
    reaches the terminal, because that is the one thing a user watching the
    server actually needs to see.

    Attached to the console **and** to the shared ``quran.log``. The word engine
    emits roughly 17 KB per mushaf line, which fills that 5 MB file several times
    over in a single sura — and a rollover it cannot complete is what wedged a run
    hard enough to look like a dead engine (see
    ``config.logging_handlers.SharedRotatingFileHandler``). The trace is not lost:
    it is duplicated there from the per-run file, which is where it is actually
    read, and which has retention of its own.

    It is a handler filter, never ``propagate = False``: ``core`` must keep
    reaching the root logger, because ``core.trace.setup_file_logging`` attaches
    each run's own file handler there and silencing propagation would empty every
    run log — the opposite of what this is for.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        return not (record.name == "core" or record.name.startswith("core."))

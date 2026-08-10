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

    This is attached to the console handler alone. ``core`` keeps propagating to
    the root logger, which matters — ``core.pipeline.setup_file_logging``
    attaches each run's own file handler there, and silencing propagation would
    empty every run log.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        return not (record.name == "core" or record.name.startswith("core."))

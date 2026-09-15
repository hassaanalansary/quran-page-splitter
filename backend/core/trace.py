"""Give one run its own log file.

Every engine in here narrates through ``logging`` and configures nothing itself —
that is what lets the same call write a file in the web app, print to a terminal
from the CLI, and cost only a level check in a test. This is the other half of that
bargain: the two lines a *caller* needs to route one run's trace into one file.

It sits at the top of ``core`` rather than inside an engine because both engines'
callers want it. It used to live in ``page_detection.pipeline``, which meant the
word engine's log plumbing (``api.services.run_logs``) imported from the page
detector to get it — a dependency that said nothing true about either.

The handler goes on the **root** logger deliberately: every ``core.*`` and ``api.*``
logger propagates there, so a run log captures the engine's trace and the service's
narration together without either having to know the file exists.
"""

from __future__ import annotations

import logging

#: One line per record: when, which logger, how bad, what. The column widths are
#: what make a few thousand lines scannable by eye, which is the only way anybody
#: reads these.
FORMAT = "%(asctime)s  %(name)-30s  %(levelname)-8s  %(message)s"


def setup_file_logging(log_path: str, level: int | str = logging.DEBUG) -> logging.FileHandler:
    """Attach a file handler to the root logger; returns it for teardown.

    DEBUG by default, which is the whole trace. ``level`` exists for a caller that
    has to trade detail for disk — see ``RUN_LOG_LEVEL``; ``core`` reads no settings
    of its own, so the choice arrives as an argument.

    Exposed at module level because a caller that drives several runs into one log
    file owns the handler for the whole span, not per run.
    """
    file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
    file_handler.setLevel(level)
    file_handler.setFormatter(logging.Formatter(FORMAT))
    logging.getLogger().addHandler(file_handler)
    return file_handler


def teardown_file_logging(file_handler: logging.FileHandler) -> None:
    """Detach and close a handler from :func:`setup_file_logging`."""
    logging.getLogger().removeHandler(file_handler)
    file_handler.close()

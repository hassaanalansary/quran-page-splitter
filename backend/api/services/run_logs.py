"""Per-run artefacts on disk: minted, pruned, and read back the same way for both engines.

Detection and word detection each write one detailed log per run, and both are read
by the same live viewer. What differs is only the row that points at the file — a
``ProcessingRun`` for detection, the ``ProcessJob`` itself for a word run, which has
no run row of its own. So the paths live here and each side keeps its own pointer.

A run also leaves a **machine-readable report** beside its log, sharing the token:
``<token>.log`` to read, ``<token>.json`` to grep and diff across runs. The pair is
minted and pruned together, because half of it is worse than neither — a report
whose log has been swept is a set of numbers with nothing to explain them.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterable
from datetime import datetime
from pathlib import Path

from django.conf import settings

from core.trace import setup_file_logging, teardown_file_logging

logger = logging.getLogger(__name__)

#: Where run logs live, relative to ``settings.LOG_DIR``. Stored paths are
#: POSIX-style and relative to that root, never absolute — a database holding an
#: absolute path would break the moment the project moved.
RUNS_SUBDIR = "runs"

#: Bytes served per tail request. A poll never returns an unbounded blob; a viewer
#: opened on a long finished run simply catches up over a few polls.
CHUNK_BYTES = 256 * 1024


def runs_dir() -> Path:
    return Path(settings.LOG_DIR) / RUNS_SUBDIR


def allocate() -> tuple[str, Path]:
    """Mint a new run log path, sweeping the old ones first.

    Returns ``(relative, absolute)`` — the first is what a row stores, the second
    is what a handler opens. Pruning on allocate keeps the directory bounded
    without a separate cleanup job, and it is the one moment where a sweep can
    never delete the log of a run still in flight.
    """
    directory = runs_dir()
    directory.mkdir(parents=True, exist_ok=True)
    prune(directory)
    token = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    return f"{RUNS_SUBDIR}/{token}.log", directory / f"{token}.log"


def report_path(log: Path) -> Path:
    """The JSON report that belongs beside a log file."""
    return log.with_suffix(".json")


def resolve(relative: str) -> Path | None:
    """Absolute path for a stored pointer, or None when it is gone or foreign.

    The containment check is the point: a stored value is data, and a row holding
    ``../../etc/passwd`` must resolve to nothing rather than to a file.
    """
    if not relative:
        return None
    root = Path(settings.LOG_DIR).resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


def retention(keep: int | None = None) -> int:
    if keep is None:
        keep = int(getattr(settings, "RUN_LOG_RETENTION", 30))
    return keep


def stale_entries(listing: Callable[[], Iterable[Path]], keep: int) -> list[Path]:
    """Everything past the newest ``keep`` entries, by modification time.

    ``listing`` is deferred so the directory read happens inside the guard:
    filesystem errors leave the directory alone rather than failing the run that
    triggered the sweep. (``Path.iterdir`` scans eagerly, so passing an iterator
    would raise before ever getting here.)
    """
    try:
        ordered = sorted(listing(), key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        return []
    return ordered[keep:]


def prune(directory: Path, keep: int | None = None) -> int:
    """Keep the newest ``keep`` run logs under *directory*; delete the rest.

    A whole-mushaf run logs several MB and a whole-sura word run rather more, which
    is the storage this reclaims — the rows themselves are a few hundred bytes and
    are kept, so pruned runs still appear in the history.

    Rows that pointed at a deleted file have their pointer cleared, which is what
    makes the UI honest: the "view the log" affordances disappear instead of
    offering a dead link. **Both** tables are swept, because both mint from this
    directory and neither knows which files the other owns.

    Best-effort on the filesystem side: failing to delete an old log is never a
    reason to fail the run that triggered the sweep.
    """
    # Imported here rather than at module scope: the services this module serves
    # are imported by ``api.models``' own callers, and a top-level import would
    # close that loop.
    from api.models import ProcessingRun, ProcessJob

    keep = retention(keep)
    if keep < 0:
        return 0

    pruned: list[str] = []
    for stale in stale_entries(lambda: directory.glob("*.log"), keep):
        try:
            stale.unlink()
        except OSError:
            continue
        # The report shares the token and is meaningless without its log.
        report_path(stale).unlink(missing_ok=True)
        pruned.append(f"{directory.name}/{stale.name}")

    if pruned:
        ProcessingRun.objects.filter(log_path__in=pruned).update(log_path="")
        ProcessJob.objects.filter(log_path__in=pruned).update(log_path="", log_url="")
        logger.info("Pruned %d old run log(s) from %s", len(pruned), directory)
    return len(pruned)


def tail(path: Path, offset: int = 0, limit: int = CHUNK_BYTES) -> dict:
    """Read a log forward from ``offset``, for a client that polls as it grows.

    Returns the text read plus the offset to resume from. Only whole lines are
    emitted: a chunk boundary must not split a UTF-8 sequence, and a reader
    tailing a file being written to must not be handed half a line it would then
    see repeated. Any remainder is picked up by the next call.

    ``reset`` says the file is shorter than the offset asked for — it was replaced
    or truncated — so the caller should clear what it has and start over.
    """
    size = path.stat().st_size

    start = max(0, int(offset))
    reset = start > size
    if reset:
        start = 0

    limit = max(0, int(limit))
    with path.open("rb") as handle:
        handle.seek(start)
        chunk = handle.read(limit)

    if chunk and not chunk.endswith(b"\n"):
        cut = chunk.rfind(b"\n")
        if cut != -1:
            chunk = chunk[: cut + 1]
        elif len(chunk) < limit:
            # A partial line still being written, and no newline to fall back on.
            # Leave it for the next poll rather than emitting a fragment.
            chunk = b""
        # else: one line longer than the whole chunk — send it as-is, otherwise
        # the reader would never advance past it.

    return {
        "offset": start + len(chunk),
        "size": size,
        "text": chunk.decode("utf-8", errors="replace"),
        "reset": reset,
    }


def attach(path: Path, *, level: str | None = None) -> logging.FileHandler:
    """Attach this run's file handler to the root logger; returns it for ``detach``.

    Literally the handler ``core.trace`` installs, so one viewer reads either
    engine's trace in one format. It goes on the **root** logger on purpose: every
    ``core.*`` and ``api.*`` logger propagates there, so a run log captures the
    engine's trace and the service's narration together without either having to
    know the file exists.

    DEBUG unless ``RUN_LOG_LEVEL`` says otherwise — the setting is where the
    detail-against-disk trade-off is documented.

    ``level`` lets one run override that for itself, which is what a very long span
    does: the per-line trade-off the setting makes for a sura stops being a trade-off
    at 9,000 lines. It only ever narrows what a run records — a caller asking for
    less than the configured level gets less, never more.
    """
    configured = getattr(settings, "RUN_LOG_LEVEL", "DEBUG")
    if level is None:
        return setup_file_logging(str(path), configured)
    names = logging.getLevelNamesMapping()
    wanted = names.get(level.upper(), logging.DEBUG)
    floor = names.get(str(configured).upper(), logging.DEBUG)
    return setup_file_logging(str(path), max(wanted, floor))


def detach(handler: logging.FileHandler) -> None:
    """Detach and close a handler from :func:`attach`."""
    teardown_file_logging(handler)

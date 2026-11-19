"""A snapshot's blob descriptors, kept in a file beside its raster.

Every library build needs the descriptor of every confirmed blob: 24,640 of them on
373 line images when 26 pages were confirmed. Measuring them from each line's label
raster took most of a build's 6.5 seconds, and the in-memory cache (256 lines) could
not hold every confirmed line, so each build measured most of them again, and a
restart forgot them all.

A snapshot never changes, so neither do its descriptors. They are measured once,
saved as ``features-v<FEATURE_VERSION>.npz`` in the snapshot's own folder (beside
``labels.png``), and read back afterwards. A new ``FEATURE_VERSION`` names a new
file, so an old one is never read as current.

The file is a cache, never a source: one that is missing, torn or unreadable is
measured again, and one that can't be written changes nothing but the next build's
speed. Bundles and copies carry only the snapshot's two PNGs; a copy measures its
own descriptors the first time it needs them.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import numpy as np

from api.models import CalibrationSnapshot
from core.word_boundary.examples import FEATURE_VERSION


def saved_features_path(snapshot: CalibrationSnapshot) -> Path | None:
    """Where the snapshot's descriptors are kept, beside its raster, or None when its
    storage has no local files to put them beside."""
    try:
        labels = Path(snapshot.labels.path)
    except (NotImplementedError, ValueError):
        return None
    return labels.with_name(f"features-v{FEATURE_VERSION}.npz")


def read_saved_features(snapshot: CalibrationSnapshot) -> dict[int, np.ndarray] | None:
    """The descriptors saved for the snapshot, by blob id, or None when there is no
    readable file."""
    path = saved_features_path(snapshot)
    if path is None or not path.exists():
        return None
    try:
        with np.load(path) as stored:
            ids, vectors = stored["ids"], stored["vectors"]
    except (OSError, ValueError, KeyError):
        return None
    if len(ids) != len(vectors):
        return None
    return {int(ident): vectors[index] for index, ident in enumerate(ids)}


def save_features(snapshot: CalibrationSnapshot, found: dict[int, np.ndarray]) -> None:
    """Keep the snapshot's descriptors beside its raster.

    Compressed: a line's descriptors shrink about twelvefold (270 KB to some 23 KB),
    for about 0.15 s more per library build of 26 pages. Written to a temporary name
    and moved into place, so a reader never sees half a file. Two requests measuring
    the same snapshot write the same bytes, and whichever lands last wins.
    """
    path = saved_features_path(snapshot)
    if path is None:
        return
    ids = np.fromiter(found, dtype=np.int64, count=len(found))
    vectors = np.stack(list(found.values())) if found else np.zeros((0, 0), dtype=np.float32)
    temporary = path.with_name(f"{path.stem}.{uuid.uuid4().hex}.tmp.npz")
    try:
        np.savez_compressed(temporary, ids=ids, vectors=vectors)
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)


__all__ = ["read_saved_features", "save_features", "saved_features_path"]

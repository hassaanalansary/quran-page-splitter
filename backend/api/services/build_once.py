"""One build at a time for each key: requests that need the same slow result wait for
the build already running instead of starting their own.

The development server answers every request on a thread of its own. When a
page's fingerprint library is not built yet, its first few requests (the type
guesses as the page opens, a lookup for each blob selected) would each start the
same ten-second build beside the others, sharing one CPU, so every one of them
took several times as long. With a lock per key, the first builds and the rest
wait, then find the result in the cache.

Usage::

    found = cache.get(key)
    if found is None:
        with builds.lock_for(key):
            found = cache.get(key)  # built while this request waited
            if found is None:
                found = cache[key] = build()
"""

from __future__ import annotations

import threading
from collections.abc import Hashable


class BuildOnce:
    """A lock per key, made on first use. The locks are kept: one per library ever
    asked for in this process, a few hundred bytes each."""

    def __init__(self) -> None:
        self.locks: dict[Hashable, threading.Lock] = {}
        self.guard = threading.Lock()

    def lock_for(self, key: Hashable) -> threading.Lock:
        with self.guard:
            lock = self.locks.get(key)
            if lock is None:
                lock = self.locks[key] = threading.Lock()
            return lock


__all__ = ["BuildOnce"]

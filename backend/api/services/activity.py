"""Activity events: the per-mushaf audit feed.

Mutating services call ``emit`` at their commit points; the detail page reads
the feed via ``list_events``. Payloads must stay JSON-serializable.
"""

from accounts.models import User
from api.models import ActivityEvent, Mushaf


def emit(mushaf: Mushaf, event_type: str, payload: dict | None = None, *, actor: User | None = None) -> None:
    """Record one activity event.

    ``actor`` is optional because background work (a processing run settling
    after the request has gone) has no user to attribute it to.
    """
    ActivityEvent.objects.create(mushaf=mushaf, type=event_type, payload=payload or {}, actor=actor)


def list_events(mushaf: Mushaf, limit: int = 50) -> list[dict]:
    """Newest-first activity feed for a mushaf (limit clamped to 1..200)."""
    limit = max(1, min(limit, 200))
    rows = mushaf.activity_events.order_by("-created_at").values("id", "type", "payload", "created_at")[:limit]
    return [dict(row) for row in rows]

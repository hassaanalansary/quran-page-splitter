"""The worker's writes to its job row: progress while it works, the outcome when it ends.

Both are one ``UPDATE`` that reads nothing back. Two concurrent writes then cannot
overwrite each other's columns, and a progress tick costs one statement.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.utils import timezone

from api.models import ProcessJob


def record_job_progress(job_id: uuid.UUID, **fields: Any) -> None:
    """Write ``fields`` to the job's row and renew its heartbeat.

    Every call counts as a sign of life: ``dead_jobs.mark_silent_jobs_interrupted``
    reads the heartbeat to tell a slow page from a dead worker.
    """
    ProcessJob.objects.filter(pk=job_id).update(heartbeat_at=timezone.now(), **fields)


def record_job_outcome(job_id: uuid.UUID, state: str, **fields: Any) -> None:
    """Settle the job in its final ``state``, with whatever else the outcome carries."""
    record_job_progress(job_id, state=state, phase="finished", current_page=None, ended_at=timezone.now(), **fields)

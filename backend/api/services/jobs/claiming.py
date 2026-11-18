"""A worker takes a queued job for itself: ``queued`` becomes ``running``.

The first thing ``execution.execute_job`` does. The claim is what makes it safe for
a job to be dispatched twice, and what decides a race between a worker and a cancel.
"""

from __future__ import annotations

import uuid

from django.utils import timezone

from api.models import ProcessJob, ProcessJobStateChoices


def claim_queued_job(job_id: uuid.UUID, worker_name: str) -> ProcessJob | None:
    """Mark the job as running on ``worker_name`` and return its row, or None when the
    job is no longer queued.

    One conditional ``UPDATE … WHERE state = 'queued'``, so only one caller can win.
    The loser was a second delivery of the same job, or arrived after the job was
    cancelled while it waited. It gets None and must do nothing.

    The row comes back with its mushaf and its user loaded: a runner reads all of
    its inputs from this row.
    """
    now = timezone.now()
    claimed = ProcessJob.objects.filter(pk=job_id, state=ProcessJobStateChoices.QUEUED).update(
        state=ProcessJobStateChoices.RUNNING,
        run_started_at=now,
        # Alive from the moment it is claimed. A job that dies before its first
        # progress tick then still ages out, and does not block its mushaf for good.
        heartbeat_at=now,
        claimed_by_worker=worker_name,
    )
    if not claimed:
        return None
    return ProcessJob.objects.select_related("mushaf", "requested_by").get(pk=job_id)

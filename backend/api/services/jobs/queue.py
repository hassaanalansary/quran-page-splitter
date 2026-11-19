"""The queue: the jobs that wait for a worker slot, first come, first served.

There is no queue table. The queue is the ``queued`` rows of ``ProcessJob`` in the
order they were requested, which is also the order their messages went to Redis.
Only a Celery worker has a queue behind it: a thread or the request itself starts a
job at once (``dispatch``).
"""

from __future__ import annotations

from api.models import ProcessJob, ProcessJobStateChoices


def count_queued_jobs() -> int:
    """How many jobs are waiting for a worker."""
    return ProcessJob.objects.filter(state=ProcessJobStateChoices.QUEUED).count()


def count_jobs_ahead_in_queue(job: ProcessJob) -> int | None:
    """How many queued jobs were requested before this one: what the client shows as
    "2 ahead of you". None for a job that is not queued, which has no place in the queue.

    Running jobs are not counted. They are not ahead in the queue: they hold the
    slots the queue waits for.
    """
    if job.state != ProcessJobStateChoices.QUEUED:
        return None
    return ProcessJob.objects.filter(state=ProcessJobStateChoices.QUEUED, requested_at__lt=job.requested_at).count()

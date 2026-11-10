"""Hands a created job to whatever runs it: the request itself, or a worker thread.

A thread is the real path. Inline (``PROCESS_JOBS_INLINE``) is for the tests and the
debug commands: the job has settled by the time the call returns, with no thread and
no second database connection involved.
"""

from __future__ import annotations

import threading

from django.conf import settings
from django.db import connections

from api.models import ProcessJob
from api.services.jobs.execution import JobRunner, execute_job


def dispatch_job(job: ProcessJob, run_the_job: JobRunner, *, inline: bool | None = None) -> ProcessJob:
    """Set the job going and return its row as it stands right after.

    ``inline`` picks the request's own thread (True) or a worker thread (False).
    Left out, the ``PROCESS_JOBS_INLINE`` setting decides.
    """
    if inline is None:
        inline = bool(getattr(settings, "PROCESS_JOBS_INLINE", False))
    if inline:
        execute_job(job, run_the_job)
    else:
        threading.Thread(target=execute_job_on_worker_thread, args=(job, run_the_job), daemon=True).start()
    job.refresh_from_db()
    return job


def execute_job_on_worker_thread(job: ProcessJob, run_the_job: JobRunner) -> None:
    """Run the job, then close this thread's database connections. Each thread opens
    its own, and nothing else closes them when a daemon thread ends."""
    try:
        execute_job(job, run_the_job)
    finally:
        connections.close_all()

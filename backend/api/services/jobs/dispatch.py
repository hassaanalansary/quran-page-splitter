"""Hands a queued job to whatever runs it: the request itself, or a worker thread.

A thread is the real path. Inline (``PROCESS_JOBS_INLINE``) is for the tests and the
debug commands: the job has settled by the time the call returns, with no thread and
no second database connection involved.

Only the job's id is handed over. The worker claims the row and reads the rest from it.
"""

from __future__ import annotations

import os
import socket
import threading
import uuid

from django.conf import settings
from django.db import connections

from api.models import ProcessJob
from api.services.jobs.execution import execute_job

#: What ``claimed_by_worker`` says for a job that ran inside the request.
INLINE_WORKER_NAME = "inline"


def dispatch_job(job: ProcessJob, *, inline: bool | None = None) -> ProcessJob:
    """Set the job going and return its row as it stands right after.

    ``inline`` picks the request's own thread (True) or a worker thread (False).
    Left out, the ``PROCESS_JOBS_INLINE`` setting decides.
    """
    if inline is None:
        inline = bool(getattr(settings, "PROCESS_JOBS_INLINE", False))
    if inline:
        execute_job(job.id, INLINE_WORKER_NAME)
    else:
        threading.Thread(target=execute_job_on_worker_thread, args=(job.id,), daemon=True).start()
    job.refresh_from_db()
    return job


def execute_job_on_worker_thread(job_id: uuid.UUID) -> None:
    """Run the job, then close this thread's database connections. Each thread opens
    its own, and nothing else closes them when a daemon thread ends."""
    try:
        execute_job(job_id, name_worker_thread())
    finally:
        connections.close_all()


def name_worker_thread() -> str:
    """The worker name of a thread of this web process: ``thread@host:pid``."""
    return f"thread@{socket.gethostname()}:{os.getpid()}"

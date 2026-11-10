"""Hands a queued job to whatever runs it. ``JOB_RUNNER`` picks one of three:

``celery``   a Celery worker, in its own process. The job's id goes to the queue in
             Redis. The run survives a restart of the web process.
``thread``   a thread of this web process. No extra service, and no queue.
``inline``   the request itself. For the tests and the debug commands: the job has
             settled by the time the call returns.

Only the job's id is handed over. The worker claims the row and reads the rest from it.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import uuid

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import connections, transaction
from kombu.exceptions import OperationalError
from ninja.errors import HttpError

from api import i18n
from api.models import ProcessJob, ProcessJobStateChoices
from api.services.jobs.execution import execute_job
from api.services.jobs.progress import record_job_outcome
from api.tasks import run_job_task

logger = logging.getLogger(__name__)

CELERY = "celery"
THREAD = "thread"
INLINE = "inline"
JOB_RUNNERS = (CELERY, THREAD, INLINE)

#: What ``claimed_by_worker`` says for a job that ran inside the request.
INLINE_WORKER_NAME = "inline"


def dispatch_job(job: ProcessJob, *, job_runner: str | None = None) -> ProcessJob:
    """Set the job going and return its row as it stands right after.

    ``job_runner`` is one of ``JOB_RUNNERS``. Left out, the settings decide
    (``choose_job_runner``).

    A thread and a Celery worker read the row through their own database connection,
    so the job is handed to them only once the transaction that created it has
    committed. Outside a transaction that is at once.
    """
    job_runner = job_runner or choose_job_runner()
    if job_runner == INLINE:
        execute_job(job.id, INLINE_WORKER_NAME)
    elif job_runner == THREAD:
        transaction.on_commit(lambda: start_worker_thread(job.id))
    elif job_runner == CELERY:
        transaction.on_commit(lambda: send_new_job_to_celery(job.id))
    else:
        raise ImproperlyConfigured(f"JOB_RUNNER must be one of {JOB_RUNNERS}, not {job_runner!r}.")
    job.refresh_from_db()
    return job


def choose_job_runner() -> str:
    """The job runner the settings ask for. ``PROCESS_JOBS_INLINE`` wins over
    ``JOB_RUNNER``: it is how a test makes every job settle inside its request."""
    if getattr(settings, "PROCESS_JOBS_INLINE", False):
        return INLINE
    return str(getattr(settings, "JOB_RUNNER", THREAD))


def send_new_job_to_celery(job_id: uuid.UUID) -> None:
    """Put a job that was just created on the queue. When the queue cannot be reached,
    nothing will ever run the job: it is settled as ``error``, and the request
    answers 503."""
    try:
        send_job_to_celery(job_id)
    except OperationalError as error:
        logger.exception("Job %s could not be sent to the queue", job_id)
        record_job_outcome(job_id, ProcessJobStateChoices.ERROR, error="The job queue could not be reached.")
        raise HttpError(503, i18n.t("job_queue_unavailable")) from error


def send_job_to_celery(job_id: uuid.UUID) -> None:
    """Put the job's id on the queue. The task id is the job id, so a job is easy to
    find in the worker's log and in Flower. Raises ``kombu.exceptions.OperationalError``
    when the queue cannot be reached."""
    run_job_task.apply_async(args=[str(job_id)], task_id=str(job_id))


def start_worker_thread(job_id: uuid.UUID) -> None:
    threading.Thread(target=execute_job_on_worker_thread, args=(job_id,), daemon=True).start()


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

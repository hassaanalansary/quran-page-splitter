"""Runs one job from its row and makes sure it settles, whatever the runner does.

``dispatch.dispatch_job`` gets this called with the job's id: on the request's own
thread, or on a worker thread. Nothing but the id is handed over. Everything else is
read from the row.
"""

from __future__ import annotations

import logging
import uuid

from api.models import ProcessJobStateChoices
from api.services.jobs.claiming import claim_queued_job
from api.services.jobs.progress import record_job_outcome
from api.services.jobs.queries import is_job_settled
from api.services.jobs.runner_registry import load_job_runner

logger = logging.getLogger(__name__)


def execute_job(job_id: uuid.UUID, worker_name: str) -> None:
    """Claim the job and run it.

    Does nothing when the claim fails: the job was cancelled while it waited, or it
    was dispatched twice and another worker has it. A runner that raises settles the
    job as ``error``, and so does a runner that returns without settling it: a poller
    must never wait for ever.
    """
    job = claim_queued_job(job_id, worker_name)
    if job is None:
        return
    try:
        run_the_job = load_job_runner(job.kind)
        run_the_job(job)
    except Exception as error:  # a job must never take its worker down
        logger.exception("Job %s failed", job.id)
        record_job_outcome(job.id, ProcessJobStateChoices.ERROR, error=str(error) or error.__class__.__name__)
        return
    if not is_job_settled(job.id):
        record_job_outcome(job.id, ProcessJobStateChoices.ERROR, error="Processing ended without a result.")

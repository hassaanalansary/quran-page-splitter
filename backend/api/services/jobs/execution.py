"""Runs one job and makes sure it settles, whatever the runner does.

``dispatch.dispatch_job`` calls this, on the request's own thread or on a worker thread.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from api.models import ProcessJob, ProcessJobStateChoices
from api.services.jobs.progress import record_job_outcome
from api.services.jobs.queries import is_job_settled

logger = logging.getLogger(__name__)

#: The worker half of one kind of job: a ``run_…_job`` from ``kinds/``, bound to its inputs.
JobRunner = Callable[[ProcessJob], None]


def execute_job(job: ProcessJob, run_the_job: JobRunner) -> None:
    """Run the job. A runner that raises settles it as ``error``, and so does a runner
    that returns without settling it: a poller must never wait for ever."""
    try:
        run_the_job(job)
    except Exception as error:  # a job must never take its worker down
        logger.exception("Job %s failed", job.id)
        record_job_outcome(job.id, ProcessJobStateChoices.ERROR, error=str(error) or error.__class__.__name__)
        return
    if not is_job_settled(job.id):
        record_job_outcome(job.id, ProcessJobStateChoices.ERROR, error="Processing ended without a result.")

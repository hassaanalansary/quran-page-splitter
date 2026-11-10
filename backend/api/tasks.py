"""The one Celery task: run a job.

The message carries the job's id and nothing else. The row carries the rest, and the
row is also the result, so no result backend is configured.
"""

from __future__ import annotations

import uuid
from typing import Any

from celery import shared_task

from api.services.jobs.execution import execute_job

#: The task's name on the wire. It is fixed here, so moving this module never
#: strands a message that is already in the queue.
RUN_JOB_TASK_NAME = "api.run_job"


@shared_task(bind=True, name=RUN_JOB_TASK_NAME)
def run_job_task(self: Any, job_id: str) -> None:
    execute_job(uuid.UUID(job_id), worker_name=self.request.hostname)

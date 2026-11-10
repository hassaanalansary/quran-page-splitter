"""Which function runs each kind of job.

``execution.execute_job`` asks here once it has claimed a job. The runners are named
by their dotted path and imported on demand. A direct import would be a circle: every
module in ``kinds/`` imports ``dispatch``, which imports ``execution``, which imports
this module.
"""

from __future__ import annotations

from collections.abc import Callable

from django.utils.module_loading import import_string

from api.models import ProcessJob, ProcessJobKindChoices

#: The worker half of one kind of job. It reads every input from the job's row.
JobRunner = Callable[[ProcessJob], None]

JOB_RUNNER_PATHS: dict[str, str] = {
    ProcessJobKindChoices.DETECTION: "api.services.jobs.kinds.detection.run_detection_job",
    ProcessJobKindChoices.CALIBRATION: "api.services.jobs.kinds.calibration_page.run_calibration_page_job",
    ProcessJobKindChoices.CALIBRATION_BATCH: "api.services.jobs.kinds.calibration_batch.run_calibration_batch_job",
}


def load_job_runner(kind: str) -> JobRunner:
    """The ``run_…_job`` function of ``kind``. Raises ``LookupError`` for a kind that
    has no runner, such as ``words``, which is kept only for old rows."""
    path = JOB_RUNNER_PATHS.get(kind)
    if path is None:
        raise LookupError(f"No runner is registered for the job kind {kind!r}.")
    runner: JobRunner = import_string(path)
    return runner

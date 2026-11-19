"""Which job states are final. Every other module of the job system asks here."""

from __future__ import annotations

from api.models import ProcessJob, ProcessJobStateChoices

#: States a job can settle in. Any other state means the job still holds its mushaf.
TERMINAL_STATES = frozenset(
    {
        ProcessJobStateChoices.COMPLETED,
        ProcessJobStateChoices.ABORTED_LINE_DETECTION,
        ProcessJobStateChoices.CANCELLED,
        ProcessJobStateChoices.ERROR,
        ProcessJobStateChoices.INTERRUPTED,
    }
)


def is_job_finished(job: ProcessJob) -> bool:
    """Whether this copy of the row is in a final state. It reads no fresh data: a
    caller that waits for a job refreshes the row first."""
    return job.state in TERMINAL_STATES

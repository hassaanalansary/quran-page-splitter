"""The job row as the API returns it: the one shape every poll and every start answers with."""

from __future__ import annotations

from api.models import ProcessJob


def serialize_job(job: ProcessJob) -> dict:
    """The job as a plain dict, in the shape of ``api.views.processing.JobOut``."""
    return {
        "id": job.id,
        "mushaf_id": job.mushaf_id,
        "state": job.state,
        "phase": job.phase,
        "page_range_start": job.page_range_start,
        "page_range_end": job.page_range_end,
        "total": job.total,
        "pages_saved": job.pages_saved,
        "current_page": job.current_page,
        "cancel_requested": job.cancel_requested,
        "started_at": job.started_at,
        "ended_at": job.ended_at,
        "run_id": job.run_id,
        "log_url": job.log_url or None,
        "stopped_on_page": job.stopped_on_page,
        "abort_info": job.abort_info,
        "error": job.error or None,
        "start_sura": job.start_sura,
        "start_aya": job.start_aya,
        "end_sura": job.end_sura,
        "end_aya": job.end_aya,
        "kind": job.kind,
        # Null on the column means "not applicable": a detection run counts pages.
        # The client has one number to show either way, so it gets zero, and no
        # reader of it has to check for null first.
        "lines_done": job.lines_done or 0,
        "report": job.report,
    }

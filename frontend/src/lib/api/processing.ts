// Detection runs as a background job on the server: start it, poll it, stop it.
// The request only kicks the run off — see backend/api/services/jobs.py.
import { apiGet, apiJson } from "./http";
import type { ProcessJob, ProcessRequest, Run } from "./types";

/** Start a run. 409 if this mushaf already has one in flight. */
export function startProcess(
  id: string,
  req: ProcessRequest,
  signal?: AbortSignal,
): Promise<ProcessJob> {
  return apiJson<ProcessJob>("POST", `/api/mushafs/${id}/process`, req, signal);
}

/** The mushaf's current or most recent run; `job` is null when it has never run.
 * Keyed by mushaf, so this still finds a run started before a page reload. */
export function getProcessJob(id: string, signal?: AbortSignal): Promise<ProcessJob | null> {
  return apiGet<{ job: ProcessJob | null }>(`/api/mushafs/${id}/process/job`, signal).then(
    (body) => body.job,
  );
}

/** Ask the running job to stop at the next page boundary (404 if none is).
 * Returns straight away — poll for the settled outcome. */
export function cancelProcess(id: string, signal?: AbortSignal): Promise<ProcessJob> {
  return apiJson<ProcessJob>("POST", `/api/mushafs/${id}/process/cancel`, undefined, signal);
}

export function listRuns(id: string, signal?: AbortSignal): Promise<Run[]> {
  return apiGet<Run[]>(`/api/mushafs/${id}/runs`, signal);
}

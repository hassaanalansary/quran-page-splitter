// Synchronous detection over a logical page range + stored run history.
import { apiGet, apiJson } from "./http";
import type { ProcessRequest, ProcessResult, Run } from "./types";

export function processMushaf(
  id: string,
  req: ProcessRequest,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return apiJson<ProcessResult>("POST", `/api/mushafs/${id}/process`, req, signal);
}

export function listRuns(id: string, signal?: AbortSignal): Promise<Run[]> {
  return apiGet<Run[]>(`/api/mushafs/${id}/runs`, signal);
}

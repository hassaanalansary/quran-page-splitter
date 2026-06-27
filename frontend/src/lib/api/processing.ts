// Synchronous detection over a logical page range.
import { apiJson } from "./http";
import type { ProcessRequest, ProcessResult } from "./types";

export function processMushaf(
  id: string,
  req: ProcessRequest,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return apiJson<ProcessResult>("POST", `/api/mushafs/${id}/process`, req, signal);
}

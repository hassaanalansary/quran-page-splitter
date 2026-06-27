// Per-page review, finalize, and line-PNG export.
import { apiGet, apiJson } from "./http";
import type { ExportResult, FinalizeLine, PageData, PageSave } from "./types";

export function getPage(id: string, pageNumber: number, signal?: AbortSignal): Promise<PageData> {
  return apiGet<PageData>(`/api/mushafs/${id}/pages/${pageNumber}`, signal);
}

/** Save edited coordinates. Aya/sura numbers come back recomputed server-side. */
export function savePage(id: string, pageNumber: number, data: PageSave): Promise<PageData> {
  return apiJson<PageData>("POST", `/api/mushafs/${id}/pages/${pageNumber}`, data);
}

export function finalizePage(
  id: string,
  pageNumber: number,
  lines: FinalizeLine[],
): Promise<PageData> {
  return apiJson<PageData>("POST", `/api/mushafs/${id}/pages/${pageNumber}/finalize`, { lines });
}

export function exportLines(id: string, pageNumber: number): Promise<ExportResult> {
  return apiJson<ExportResult>("POST", `/api/mushafs/${id}/pages/${pageNumber}/export-lines`, {});
}

// Per-page review, finalize, and line-PNG export.
import { API_BASE, apiGet, apiJson } from "./http";
import type {
  BulkSaveInput,
  ExportResult,
  FinalizeLine,
  PageData,
  PageSave,
  PageSummary,
  ReviewData,
} from "./types";

export function getPage(id: string, pageNumber: number, signal?: AbortSignal): Promise<PageData> {
  return apiGet<PageData>(`/api/mushafs/${id}/pages/${pageNumber}`, signal);
}

/** Summaries of processed pages (which logical pages have data + review state). */
export function listPages(id: string, signal?: AbortSignal): Promise<PageSummary[]> {
  return apiGet<PageSummary[]>(`/api/mushafs/${id}/pages`, signal);
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

/** Download URL for the exported line PNGs as a zip — one page, or all of them.
 * Entries are `page-0007/line-03.png`. */
export function linesZipUrl(id: string, pageNumber?: number): string {
  const query = pageNumber != null ? `?page=${pageNumber}` : "";
  return `${API_BASE}/api/mushafs/${id}/lines.zip${query}`;
}

export function getReviewData(id: string, signal?: AbortSignal): Promise<ReviewData> {
  return apiGet<ReviewData>(`/api/mushafs/${id}/review-data`, signal);
}

export function bulkSavePages(id: string, input: BulkSaveInput): Promise<ReviewData> {
  return apiJson<ReviewData>("POST", `/api/mushafs/${id}/pages/bulk`, input);
}

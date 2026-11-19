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

/** Save a page's cuts. `page` carries what goes with them, each left as it is
 * when not given: the padding most lines and most sura headers now carry, and the
 * checked mark. */
export function finalizePage(
  id: string,
  pageNumber: number,
  lines: FinalizeLine[],
  page: { line_padding?: number; sura_header_padding?: number; lines_finalized?: boolean } = {},
): Promise<PageData> {
  return apiJson<PageData>("POST", `/api/mushafs/${id}/pages/${pageNumber}/finalize`, {
    lines,
    ...page,
  });
}

/** Mark a page's line cuts finished in Finalize, or not finished again. Only this
 * sets it — exporting never does. */
export function markLinesFinalized(
  id: string,
  pageNumber: number,
  finalized: boolean,
): Promise<{ page_number: number; lines_finalized: boolean }> {
  return apiJson("PUT", `/api/mushafs/${id}/pages/${pageNumber}/lines-finalized`, { finalized });
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

/** What the full data export carries beside its JSON — both on unless turned off. */
export type ExportOptions = { page?: number; images?: boolean; maps?: boolean };

function exportQuery({ page, images = true, maps = true }: ExportOptions): string {
  const query = new URLSearchParams();
  if (page != null) query.set("page", String(page));
  if (!images) query.set("images", "false");
  if (!maps) query.set("maps", "false");
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Download URL for the full data export (schema mushaf-export/v2): every line, aya,
 * word and blob in page and line-PNG pixels, with each line's word and blob maps —
 * the whole mushaf, or one page. See backend/api/services/data_export.py. */
export function exportUrl(id: string, options: ExportOptions = {}): string {
  return `${API_BASE}/api/mushafs/${id}/export.zip${exportQuery(options)}`;
}

/** The same export of a published mushaf, open to everyone. */
export function galleryExportUrl(id: string, options: ExportOptions = {}): string {
  return `${API_BASE}/api/gallery/${id}/export.zip${exportQuery(options)}`;
}

export function getReviewData(id: string, signal?: AbortSignal): Promise<ReviewData> {
  return apiGet<ReviewData>(`/api/mushafs/${id}/review-data`, signal);
}

export function bulkSavePages(id: string, input: BulkSaveInput): Promise<ReviewData> {
  return apiJson<ReviewData>("POST", `/api/mushafs/${id}/pages/bulk`, input);
}

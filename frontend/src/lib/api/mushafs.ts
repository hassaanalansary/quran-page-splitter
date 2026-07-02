// Mushaf CRUD, template upload, and on-demand page-image URLs.
import { API_BASE, apiDelete, apiForm, apiGet, apiJson } from "./http";
import type {
  ActivityEvent,
  Mushaf,
  MushafCreateResult,
  MushafDetail,
  MushafPatch,
  MushafStats,
  Rect,
  Template,
  TemplateType,
} from "./types";

export function listMushafs(signal?: AbortSignal): Promise<Mushaf[]> {
  return apiGet<Mushaf[]>("/api/mushafs", signal);
}

export function getMushaf(id: string, signal?: AbortSignal): Promise<MushafDetail> {
  return apiGet<MushafDetail>(`/api/mushafs/${id}`, signal);
}

export function getStats(id: string, signal?: AbortSignal): Promise<MushafStats> {
  return apiGet<MushafStats>(`/api/mushafs/${id}/stats`, signal);
}

export function listActivity(
  id: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<ActivityEvent[]> {
  return apiGet<ActivityEvent[]>(`/api/mushafs/${id}/activity?limit=${limit}`, signal);
}

/** Re-render the cover thumbnail from physical page 1. */
export function regenerateThumbnail(id: string): Promise<MushafDetail> {
  return apiJson<MushafDetail>("POST", `/api/mushafs/${id}/thumbnail`);
}

/** Download URL of the aya-coordinates JSON document (attachment). */
export function coordinatesUrl(id: string): string {
  return `${API_BASE}/api/mushafs/${id}/coordinates`;
}

export type CreateMushafInput = {
  pdf: File;
  name: string;
  qiraa?: string | null;
  first_quran_pdf_page?: number;
  last_quran_pdf_page?: number | null;
};

export function createMushaf(input: CreateMushafInput): Promise<MushafCreateResult> {
  const fd = new FormData();
  fd.append("pdf", input.pdf, input.pdf.name);
  fd.append("name", input.name);
  if (input.qiraa) fd.append("qiraa", input.qiraa);
  if (input.first_quran_pdf_page != null) {
    fd.append("first_quran_pdf_page", String(input.first_quran_pdf_page));
  }
  if (input.last_quran_pdf_page != null) {
    fd.append("last_quran_pdf_page", String(input.last_quran_pdf_page));
  }
  return apiForm<MushafCreateResult>("POST", "/api/mushafs", fd);
}

export function updateMushaf(id: string, patch: MushafPatch): Promise<Mushaf> {
  return apiJson<Mushaf>("PATCH", `/api/mushafs/${id}`, patch);
}

export function deleteMushaf(id: string): Promise<void> {
  return apiDelete(`/api/mushafs/${id}`);
}

export function listTemplates(id: string, signal?: AbortSignal): Promise<Template[]> {
  return apiGet<Template[]>(`/api/mushafs/${id}/templates`, signal);
}

export function upsertTemplate(
  id: string,
  type: TemplateType,
  input: { image?: Blob | null; ignore?: Rect | null },
): Promise<Template> {
  const fd = new FormData();
  if (input.image) fd.append("image", input.image, `${type}.png`);
  if (input.ignore) {
    fd.append("ignore_x", String(Math.round(input.ignore.x)));
    fd.append("ignore_y", String(Math.round(input.ignore.y)));
    fd.append("ignore_w", String(Math.round(input.ignore.w)));
    fd.append("ignore_h", String(Math.round(input.ignore.h)));
  }
  return apiForm<Template>("PUT", `/api/mushafs/${id}/templates/${type}`, fd);
}

/**
 * URL of a rendered logical page. `version` busts the browser cache after a
 * reprocess/finalize so the canvas reflects the latest render.
 */
export function pageImageUrl(id: string, pageNumber: number, version?: string | number): string {
  const suffix = version != null ? `?v=${version}` : "";
  return `${API_BASE}/api/mushafs/${id}/pages/${pageNumber}/image${suffix}`;
}

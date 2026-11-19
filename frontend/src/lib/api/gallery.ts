// The public gallery: browsing published mushafs, and publishing your own.
//
// Everything here except `duplicateMushaf` works signed out — the backend
// mounts these routes with auth=None (see backend/api/views/gallery.py).

import { API_BASE, apiGet, apiJson } from "./http";

export interface GalleryItem {
  id: string;
  name: string;
  description: string;
  qiraa: string | null;
  logical_page_count: number;
  processed_page_count: number;
  reviewed_page_count: number;
  thumbnail_url: string | null;
  published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** The author's display name — never their email address. */
  owner_name: string;
  /** True when you are signed in as this mushaf's author. Offering "copy to my
   * account" for something already in your account is just a confusing no-op,
   * so the card offers the way in instead. */
  is_owner: boolean;
}

export interface GalleryDetail extends GalleryItem {
  visibility: "private" | "published";
  pdf_page_count: number;
  first_quran_pdf_page: number;
  last_quran_pdf_page: number;
  line_count: number;
  /** Upper bound on what the lines.zip download contains. */
  exported_line_count: number;
}

export interface QiraaFacet {
  name: string;
  name_arabic: string;
  count: number;
}

export interface GalleryPage {
  total: number;
  items: GalleryItem[];
  /** Counted under the search and completed filters but not the qiraa one, so the
   * chips can offer every qiraa there is something in, and "All" its count. */
  facets: { all: number; qiraat: QiraaFacet[] };
}

/** Newest first, the most reviewed first, or by name. */
export type GallerySort = "published" | "complete" | "name";

export interface GalleryQuery {
  qiraa: string | null;
  /** Matches the name, qiraa or author. */
  search: string;
  completed: boolean;
  sort: GallerySort;
}

export const GALLERY_PAGE_SIZE = 24;

export function listGallery(
  params: Partial<GalleryQuery> & { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<GalleryPage> {
  const query = new URLSearchParams();
  if (params.qiraa) query.set("qiraa", params.qiraa);
  if (params.search?.trim()) query.set("q", params.search.trim());
  if (params.completed) query.set("completed", "true");
  if (params.sort && params.sort !== "published") query.set("sort", params.sort);
  query.set("limit", String(params.limit ?? GALLERY_PAGE_SIZE));
  query.set("offset", String(params.offset ?? 0));
  return apiGet<GalleryPage>(`/api/gallery?${query.toString()}`, signal);
}

export function getGalleryItem(id: string, signal?: AbortSignal): Promise<GalleryDetail> {
  return apiGet<GalleryDetail>(`/api/gallery/${id}`, signal);
}

/** Copy a published mushaf into your account. Requires a session. */
export function duplicateMushaf(id: string): Promise<{ id: string; name: string }> {
  return apiJson<{ id: string; name: string }>("POST", `/api/gallery/${id}/duplicate`);
}

export function publishMushaf(id: string, description?: string): Promise<GalleryDetail> {
  return apiJson<GalleryDetail>("POST", `/api/mushafs/${id}/publish`, {
    description: description ?? null,
  });
}

export function unpublishMushaf(id: string): Promise<GalleryDetail> {
  return apiJson<GalleryDetail>("POST", `/api/mushafs/${id}/unpublish`);
}

/** Download URLs for a published mushaf's artifacts (open to everyone). */
export function galleryCoordinatesUrl(id: string): string {
  return `${API_BASE}/api/gallery/${id}/coordinates`;
}

export function galleryLinesZipUrl(id: string, page?: number): string {
  const suffix = page != null ? `?page=${page}` : "";
  return `${API_BASE}/api/gallery/${id}/lines.zip${suffix}`;
}

// Client for the Raqam line-cut (PNG-export) review endpoints.
import { RAQAM_API_BASE } from "./raqam";

async function readJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" && payload !== null && "detail" in payload
        ? (payload as { detail?: string }).detail
        : undefined;
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return payload as T;
}

export type CutReviewStatus = {
  cut_review_available: boolean;
  source_results: string | null;
  original_results: boolean;
  corrected_results: boolean;
  cut_edits: boolean;
  line_cut_results: boolean;
  final_lines_dir: string;
  pages_dir: string;
  page_count: number;
};

export type EraseStroke = {
  id: string;
  brush_size: number;
  /** [x, y] in source-image (page) pixel space. */
  points: [number, number][];
};

export type LineEdit = {
  line_number: number;
  bbox_override?: { x: number; y: number; w: number; h: number };
  erase_strokes?: EraseStroke[];
};

export type PageEdit = {
  page_number: number;
  image_filename?: string;
  page_image_filename?: string;
  lines: LineEdit[];
};

export type CutEdits = {
  schema_version?: number;
  source_path?: string;
  pages: PageEdit[];
};

export type CutReviewPayload = {
  source_path: string;
  edits_path: string;
  final_results_path: string;
  source_data: unknown;
  data: unknown;
  edits: CutEdits;
};

export function loadCutReviewStatus(): Promise<CutReviewStatus> {
  return readJson(`${RAQAM_API_BASE}/api/cut-review/status`);
}

export function loadCutReviewResults(): Promise<CutReviewPayload> {
  return readJson(`${RAQAM_API_BASE}/api/cut-review/results`);
}

export function saveCutEdits(edits: CutEdits): Promise<CutReviewPayload> {
  return readJson(`${RAQAM_API_BASE}/api/cut-review/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function exportLinePngs(): Promise<{
  exported_images: number;
  output_dir: string;
}> {
  return readJson(`${RAQAM_API_BASE}/api/cut-review/export`, { method: "POST" });
}

export function cutPageImageUrl(filename: string): string {
  // The backend exposes page images under the review endpoint.
  return `${RAQAM_API_BASE}/api/review/pages/${encodeURIComponent(filename)}`;
}

// Client for the Raqam review endpoints (see backend `server.py`).
import { RAQAM_API_BASE } from "./raqam";

async function readJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new Error(payload?.detail || `${res.status} ${res.statusText}`);
  }
  return payload as T;
}

// Backend `review_status()` returns dict[str, bool]; field names mirror it 1:1.
export type ReviewStatus = {
  review_available: boolean;
  original_results: boolean;
  corrected_results: boolean;
};

export type SaveReviewResponse = {
  status: string;
  path: string;
  data: unknown;
};

export function loadReviewStatus(): Promise<ReviewStatus> {
  return readJson(`${RAQAM_API_BASE}/api/review/status`);
}

export async function loadReviewResults(source: "latest" | "original" = "latest"): Promise<any> {
  const resp = await readJson<{ data: any; source_path: string }>(
    `${RAQAM_API_BASE}/api/review/results?source=${source}`,
  );
  return resp.data;
}

export function saveReviewResults(data: unknown): Promise<SaveReviewResponse> {
  return readJson<SaveReviewResponse>(`${RAQAM_API_BASE}/api/review/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function pageImageUrl(filename: string): string {
  return `${RAQAM_API_BASE}/api/review/pages/${encodeURIComponent(filename)}`;
}

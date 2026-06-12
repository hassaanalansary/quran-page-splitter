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

export type ReviewStatus = {
  has_results: boolean;
  has_corrected?: boolean;
  pages_count?: number;
  [k: string]: unknown;
};

export function loadReviewStatus(): Promise<ReviewStatus> {
  return readJson(`${RAQAM_API_BASE}/api/review/status`);
}

export async function loadReviewResults(
  source: "latest" | "original" = "latest",
): Promise<any> {
  const resp = await readJson<{ data: any; source_path: string }>(
    `${RAQAM_API_BASE}/api/review/results?source=${source}`,
  );
  return resp.data;
}

export function saveReviewResults(data: unknown): Promise<unknown> {
  return readJson(`${RAQAM_API_BASE}/api/review/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function pageImageUrl(filename: string): string {
  return `${RAQAM_API_BASE}/api/review/pages/${encodeURIComponent(filename)}`;
}

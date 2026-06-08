// Thin client for the Raqam FastAPI backend (default http://localhost:8000).
//
// CORS: The Python server must allow this origin. If it doesn't, the
// browser will surface a CORS error in the network panel.

export const RAQAM_API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";

export type TargetName =
  | "bounds"
  | "sura_header"
  | "aya_separator"
  | "sura_header_ignore"
  | "aya_separator_ignore";

export type Rect = { x: number; y: number; w: number; h: number };

export type Settings = {
  padding: number;
  expected_lines: number;
  sura_header_slots: number;
  sura_header_threshold: number;
  max_sura_headers: number;
  match_threshold: number;
  alternate_horizontal_margin: boolean;
  prefer_acceleration: boolean;
  start_sura: number;
  start_aya: number;
};

export type UploadPayload = {
  images: File[];
  templates: {
    sura_header: Blob;
    aya_separator: Blob;
  };
  bounds: Rect;
  ignores: {
    sura_header_ignore?: Rect | null;
    aya_separator_ignore?: Rect | null;
  };
  settings: Settings;
};

export async function uploadBatch(
  payload: UploadPayload,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const fd = new FormData();

  for (const f of payload.images) fd.append("images", f, f.name);
  fd.append("sura_header", payload.templates.sura_header, "sura_header.png");
  fd.append("aya_separator", payload.templates.aya_separator, "aya_separator.png");

  fd.append("crop_x", String(payload.bounds.x));
  fd.append("crop_y", String(payload.bounds.y));
  fd.append("crop_w", String(payload.bounds.w));
  fd.append("crop_h", String(payload.bounds.h));

  const sh = payload.ignores.sura_header_ignore;
  if (sh) {
    fd.append("sura_header_ignore_x", String(sh.x));
    fd.append("sura_header_ignore_y", String(sh.y));
    fd.append("sura_header_ignore_w", String(sh.w));
    fd.append("sura_header_ignore_h", String(sh.h));
  }
  const as = payload.ignores.aya_separator_ignore;
  if (as) {
    fd.append("aya_separator_ignore_x", String(as.x));
    fd.append("aya_separator_ignore_y", String(as.y));
    fd.append("aya_separator_ignore_w", String(as.w));
    fd.append("aya_separator_ignore_h", String(as.h));
  }

  const s = payload.settings;
  fd.append("padding", String(s.padding));
  fd.append("expected_lines", String(s.expected_lines));
  fd.append("sura_header_slots", String(s.sura_header_slots));
  fd.append("sura_header_threshold", String(s.sura_header_threshold));
  fd.append("max_sura_headers", String(s.max_sura_headers));
  fd.append("match_threshold", String(s.match_threshold));
  fd.append("alternate_horizontal_margin", String(s.alternate_horizontal_margin));
  fd.append("prefer_acceleration", String(s.prefer_acceleration));
  fd.append("start_sura", String(s.start_sura));
  fd.append("start_aya", String(s.start_aya));

  const res = await fetch(`${RAQAM_API_BASE}/upload/`, {
    method: "POST",
    body: fd,
    signal,
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { ok: res.ok, status: res.status, body };
}

/** Natural sort: "2.png" before "10.png". */
export function naturalSort(files: File[]): File[] {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return [...files].sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * Crop a region from an image File to a PNG Blob, used when posting the
 * per-target template images (sura_header / aya_separator).
 */
export async function cropImageToBlob(file: File, rect: Rect): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w));
  canvas.height = Math.max(1, Math.round(rect.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(
    bitmap,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}

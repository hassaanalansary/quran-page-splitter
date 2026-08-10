import type { Rect } from "./api/types";

/**
 * Crop a rect (in source-image pixel coordinates) out of an image URL into a
 * PNG blob. Fetches the URL as a blob first so the canvas is never tainted
 * (works for same-origin API images served via the dev proxy or Django).
 */
export async function cropUrlToBlob(url: string, rect: Rect): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load image (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.w));
    canvas.height = Math.max(1, Math.round(rect.h));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
  } finally {
    bitmap.close();
  }
}

import type { Rect } from "@/lib/api/types";

/* The edge-ink rule, as the Finalize canvas previews it. The export runs the same
 * rule on the same rendered page in `backend/core/imaging/edge_ink.py`. */

/**
 * Every 8-connected piece of ink touching a crop's top or bottom row: the
 * neighbouring lines showing through. `rgba` is the crop of the transparent
 * page, where alpha 0 is paper and anything else ink. Returns 1 where such ink
 * is, 0 elsewhere.
 *
 * The export runs the same rule on the same rendered page
 * (`backend/core/imaging/edge_ink.py`), so a change here must be made there too.
 * A flood fill from the edge rows' ink finds exactly the pieces its labelling picks.
 */
export function findEdgeInk(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const found = new Uint8Array(w * h);
  if (w === 0 || h === 0) return found;
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const row of h > 1 ? [0, h - 1] : [0]) {
    for (let x = 0; x < w; x++) {
      const i = row * w + x;
      if (rgba[i * 4 + 3] > 0 && !found[i]) {
        found[i] = 1;
        queue[tail++] = i;
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
        const n = ny * w + nx;
        if (rgba[n * 4 + 3] > 0 && !found[n]) {
          found[n] = 1;
          queue[tail++] = n;
        }
      }
    }
  }
  return found;
}

/** A line-sized canvas, opaque where the line's edge ink is (`findEdgeInk`), to
 * punch out with destination-out — or null when the line has none. The crop is
 * clipped to the page as the export clips it, so a box running past the page's
 * bottom finds the page's real last row there, not empty space. */
export function drawEdgeInkMask(page: HTMLCanvasElement, box: Rect): HTMLCanvasElement | null {
  const ctx = page.getContext("2d");
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const w = Math.min(page.width, box.x + box.w) - x;
  const h = Math.min(page.height, box.y + box.h) - y;
  if (!ctx || w <= 0 || h <= 0) return null;
  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(x, y, w, h);
  } catch {
    return null; // a tainted page can't be read — show the line as it is
  }
  const found = findEdgeInk(pixels.data, w, h);
  if (!found.includes(1)) return null;
  const mask = document.createElement("canvas");
  mask.width = box.w;
  mask.height = box.h;
  const mctx = mask.getContext("2d");
  if (!mctx) return null;
  const out = mctx.createImageData(w, h);
  for (let i = 0; i < found.length; i++) if (found[i]) out.data[i * 4 + 3] = 255;
  mctx.putImageData(out, x - box.x, y - box.y);
  return mask;
}

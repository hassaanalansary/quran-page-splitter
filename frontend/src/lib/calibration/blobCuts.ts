// The knife: cut one blob of ink into pieces along lines a person drew.
//
// Two letters printed touching are one blob, even across a word break: the alef of
// ٱلَّذِى standing on the tip of the lam's bowl in كَمَثَلِ. A body two words share is
// divided at its middle until a person cuts it. They draw a short straight line, at
// any slope, across the place the letters touch. The line only separates: the blob
// falls into pieces, and each piece belongs to one of the blob's words.
//
// The rule is backend/core/imaging/blob_cuts.py's, pixel for pixel: read its
// docstring, and change both together. In short:
//   1. ink under a line (squared distance to the segment ≤ CUT_RADIUS_SQUARED) is
//      taken out;
//   2. the rest falls into 8-connected components, numbered in raster order;
//   3. a component under crumbSize() of the blob is a crumb, not a piece;
//   4. pieces are ordered rightmost right edge first, then larger left+right, then
//      higher top, then raster order;
//   5. the line's pixels and the crumbs go back to a neighbouring piece one ring at a
//      time, the lowest piece number on a tie.
// All of it is integer arithmetic, so the server and the editor agree exactly.
//
// Pure, with only type-only imports, so blobCuts.check.ts runs under plain Node.
import type { BlobCut, CalibrationBlob, CutLine, PieceBox } from "./types.ts";

export const CUT_RADIUS_SQUARED = 1;
export const CRUMB_MIN_PIXELS = 8;
export const CRUMB_SHARE = 50;

/** The eight neighbours, in the order both languages visit them. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** A cut blob, in its own box's frame: each pixel's piece (-1 off the ink), and the
 * pieces' boxes in piece order. */
export type BlobPieces = { labels: Int32Array; width: number; height: number; boxes: PieceBox[] };

/** The fewest pixels a piece of a `total`-pixel blob may have. */
export function crumbSize(total: number): number {
  return Math.max(CRUMB_MIN_PIXELS, Math.floor(total / CRUMB_SHARE));
}

/** Whether a pixel's centre lies within the cut's radius of the segment — exact
 * integer arithmetic, as the server does it. */
export function isUnderLine(column: number, row: number, line: CutLine): boolean {
  const [x1, y1, x2, y2] = line;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const px = column - x1;
  const py = row - y1;
  const length = dx * dx + dy * dy;
  const along = px * dx + py * dy;
  if (length === 0 || along <= 0) return px * px + py * py <= CUT_RADIUS_SQUARED;
  if (along >= length) {
    const qx = column - x2;
    const qy = row - y2;
    return qx * qx + qy * qy <= CUT_RADIUS_SQUARED;
  }
  return (px * px + py * py) * length - along * along <= CUT_RADIUS_SQUARED * length;
}

/** The blob's pieces once the lines are cut through it. `mask` is 1 on the blob's
 * ink, row by row, `width` × `height`; the lines are in the same frame. */
export function cutBlobIntoPieces(
  mask: Uint8Array,
  width: number,
  height: number,
  lines: CutLine[],
): BlobPieces {
  let total = 0;
  const kept = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const at = row * width + column;
      if (!mask[at]) continue;
      total++;
      if (!lines.some((line) => isUnderLine(column, row, line))) kept[at] = 1;
    }
  }
  const smallest = crumbSize(total);
  const pieces = findComponents(kept, width, height)
    .map((pixels, index) => ({ pixels, key: pieceOrderKey(pixels, width, index) }))
    .filter(({ pixels }) => pixels.length >= smallest)
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ pixels }) => pixels);

  const labels = new Int32Array(width * height).fill(-1);
  pieces.forEach((pixels, number) => pixels.forEach((at) => (labels[at] = number)));
  if (pieces.length) giveBackPixels(mask, labels, width, height);
  return { labels, width, height, boxes: measurePieces(labels, width, height, pieces.length) };
}

/** The 8-connected components of the kept pixels, as flat indices, in the raster
 * order of their first pixel. */
function findComponents(kept: Uint8Array, width: number, height: number): number[][] {
  const seen = new Uint8Array(width * height);
  const found: number[][] = [];
  for (let start = 0; start < kept.length; start++) {
    if (!kept[start] || seen[start]) continue;
    seen[start] = 1;
    const pixels: number[] = [];
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head];
      pixels.push(at);
      const row = Math.floor(at / width);
      const column = at % width;
      for (const [dy, dx] of NEIGHBOURS) {
        const ny = row + dy;
        const nx = column + dx;
        if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
        const next = ny * width + nx;
        if (kept[next] && !seen[next]) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    found.push(pixels);
  }
  return found;
}

function pieceOrderKey(pixels: number[], width: number, rasterIndex: number): number[] {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  for (const at of pixels) {
    const column = at % width;
    left = Math.min(left, column);
    right = Math.max(right, column + 1);
    top = Math.min(top, Math.floor(at / width));
  }
  return [-right, -(left + right), top, rasterIndex];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Every ink pixel without a piece joins a neighbouring piece, one ring at a time,
 * each ring decided on the labels as they stood before it. In place. */
function giveBackPixels(mask: Uint8Array, labels: Int32Array, width: number, height: number) {
  let pending: number[] = [];
  for (let at = 0; at < labels.length; at++) if (mask[at] && labels[at] < 0) pending.push(at);
  while (pending.length) {
    const taken: [number, number][] = [];
    for (const at of pending) {
      const row = Math.floor(at / width);
      const column = at % width;
      let best = -1;
      for (const [dy, dx] of NEIGHBOURS) {
        const ny = row + dy;
        const nx = column + dx;
        if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
        const number = labels[ny * width + nx];
        if (number >= 0 && (best < 0 || number < best)) best = number;
      }
      if (best >= 0) taken.push([at, best]);
    }
    if (!taken.length) break;
    for (const [at, number] of taken) labels[at] = number;
    pending = pending.filter((at) => labels[at] < 0);
  }
  for (const at of pending) labels[at] = 0;
}

function measurePieces(
  labels: Int32Array,
  width: number,
  height: number,
  count: number,
): PieceBox[] {
  const boxes = Array.from({ length: count }, () => ({
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
    area: 0,
  }));
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const number = labels[row * width + column];
      if (number < 0) continue;
      const box = boxes[number];
      box.left = Math.min(box.left, column);
      box.top = Math.min(box.top, row);
      box.right = Math.max(box.right, column);
      box.bottom = Math.max(box.bottom, row);
      box.area++;
    }
  }
  return boxes.map((box) => ({
    x: box.left,
    y: box.top,
    w: box.right - box.left + 1,
    h: box.bottom - box.top + 1,
    area: box.area,
  }));
}

// ── On a line's label raster, in page pixels ─────────────────────────────────

type Box = { x: number; y: number };
type BlobBox = Pick<CalibrationBlob, "id" | "x" | "y" | "w" | "h">;

/** The blob's own pixels in its line's label raster, cropped to its box. The raster
 * is the line's crop of the page, so a raster column is the page x less `origin.x`. */
export function blobMask(
  ids: Uint32Array,
  rasterWidth: number,
  rasterHeight: number,
  origin: Box,
  blob: BlobBox,
): Uint8Array {
  const mask = new Uint8Array(blob.w * blob.h);
  const left = blob.x - origin.x;
  const top = blob.y - origin.y;
  for (let row = 0; row < blob.h; row++) {
    const y = top + row;
    if (y < 0 || y >= rasterHeight) continue;
    for (let column = 0; column < blob.w; column++) {
      const x = left + column;
      if (x >= 0 && x < rasterWidth && ids[y * rasterWidth + x] === blob.id)
        mask[row * blob.w + column] = 1;
    }
  }
  return mask;
}

/** Cut the blob along page-pixel lines. The labels stay in the blob's own box;
 * `boxes` come back in page pixels. */
export function cutBlobInRaster(
  ids: Uint32Array,
  rasterWidth: number,
  rasterHeight: number,
  origin: Box,
  blob: BlobBox,
  lines: CutLine[],
): BlobPieces {
  const mask = blobMask(ids, rasterWidth, rasterHeight, origin, blob);
  const local = lines.map(
    ([x1, y1, x2, y2]): CutLine => [x1 - blob.x, y1 - blob.y, x2 - blob.x, y2 - blob.y],
  );
  const pieces = cutBlobIntoPieces(mask, blob.w, blob.h, local);
  return {
    ...pieces,
    boxes: pieces.boxes.map((box) => ({ ...box, x: box.x + blob.x, y: box.y + blob.y })),
  };
}

/** The piece a page pixel of the blob is in, or -1 off its ink. */
export function pieceAt(pieces: BlobPieces, blob: BlobBox, pageX: number, pageY: number): number {
  const column = pageX - blob.x;
  const row = pageY - blob.y;
  if (column < 0 || row < 0 || column >= pieces.width || row >= pieces.height) return -1;
  return pieces.labels[row * pieces.width + column];
}

// ── A cut on a draft blob ────────────────────────────────────────────────────

/** Whether the blob's cut still says how it divides: a body, not erased, its pieces
 * one per word, and its words exactly the words the blob is shared by. The server's
 * `cut_fits_blob`. */
export function cutFitsBlob(blob: CalibrationBlob): blob is CalibrationBlob & { cut: BlobCut } {
  const cut = blob.cut;
  if (!cut || blob.role !== "body" || blob.erased) return false;
  const owners = [...cut.owners].sort((a, b) => a - b);
  const shared = blob.allocations.map((allocation) => allocation.word_id).sort((a, b) => a - b);
  return (
    owners.length >= 2 &&
    cut.pieces.length === owners.length &&
    owners.length === shared.length &&
    owners.every((owner, index) => owner === shared[index])
  );
}

/** The word's piece of a cut blob, or null when it has none. */
export function pieceOfWord(cut: BlobCut, wordId: number): PieceBox | null {
  const at = cut.owners.indexOf(wordId);
  return at < 0 ? null : (cut.pieces[at] ?? null);
}

/** The blob's words in reading order — the owners of its pieces, rightmost first,
 * before anyone swaps them. */
export function defaultOwners(blob: CalibrationBlob): number[] {
  return blob.allocations.map((allocation) => allocation.word_id).sort((a, b) => a - b);
}

/** The owners with the clicked piece's word swapped for the next piece's. With two
 * pieces, that is the swap; with more, a click walks a piece through the words. */
export function swapPieceOwner(owners: number[], piece: number): number[] {
  if (owners.length < 2 || piece < 0 || piece >= owners.length) return owners;
  const next = (piece + 1) % owners.length;
  const swapped = [...owners];
  [swapped[piece], swapped[next]] = [swapped[next], swapped[piece]];
  return swapped;
}

/** What one more knife line did. `nothing`: it split off no new piece, so it is
 * dropped. `too-many`: more pieces than the blob has words, dropped too. `more`: kept,
 * and another line is needed. `done`: one piece per word, so the cut is made. */
export type KnifeVerdict = "nothing" | "too-many" | "more" | "done";

/** The knife, out on one blob: the lines kept so far, before the cut is made. */
export type KnifeState = { snapshot: string; blobId: number; lines: CutLine[] };

/** One more line drawn with the knife: what it did, every line with it, and the
 * pieces they make. */
export type KnifeOutcome = { verdict: KnifeVerdict; lines: CutLine[]; pieces: PieceBox[] };

export function judgeKnifeLine(
  piecesBefore: number,
  piecesAfter: number,
  words: number,
): KnifeVerdict {
  if (piecesAfter > words) return "too-many";
  if (piecesAfter <= Math.max(1, piecesBefore)) return "nothing";
  return piecesAfter === words ? "done" : "more";
}

/** The pieces of every blob of a line cut with the knife, measured on its raster. */
export function cutPiecesOfLine(
  line: { blobs: CalibrationBlob[]; bbox: Box },
  raster: { ids: Uint32Array; width: number; height: number },
): Map<number, BlobPieces> {
  const found = new Map<number, BlobPieces>();
  for (const blob of line.blobs)
    if (cutFitsBlob(blob))
      found.set(
        blob.id,
        cutBlobInRaster(raster.ids, raster.width, raster.height, line.bbox, blob, blob.cut.lines),
      );
  return found;
}

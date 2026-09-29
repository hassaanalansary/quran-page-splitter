import type { CalibrationBlob, CalibrationLine, CalibrationWord } from "./types.ts";

export type PlaybackWord = { line: CalibrationLine; word: CalibrationWord; wordIndex: number };
export type RGB = readonly [number, number, number];

/** Canvas object-fit can letterbox the image; clicks must exclude that padding. */
export function containedPoint(
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  imageW: number,
  imageH: number,
) {
  const scale = Math.min(boxW / imageW, boxH / imageH);
  if (!(scale > 0)) return null;
  const px = (x - (boxW - imageW * scale) / 2) / scale;
  const py = (y - (boxH - imageH * scale) / 2) / scale;
  return px >= 0 && py >= 0 && px < imageW && py < imageH ? { x: px, y: py } : null;
}

export const BODY_INK: RGB = [0, 76, 160];
export const MARK_INK: RGB = [174, 24, 82];
export const TYPE_INK: Record<string, RGB> = {
  fatha: [160, 56, 0],
  damma: [158, 20, 96],
  kasra: [0, 105, 75],
  sukun: [105, 50, 155],
  shadda: [125, 85, 0],
  tanween: [181, 28, 28],
  madda: [124, 32, 111],
  daggerAlif: [77, 105, 0],
  smallLetter: [143, 60, 76],
  ijamDot: [77, 77, 77],
  hamza: [140, 66, 0],
  wasla: [0, 112, 101],
  waqfSili: [146, 28, 28],
  waqfQili: [120, 48, 91],
  waqfJim: [65, 110, 23],
  waqfMim: [116, 61, 137],
  waqfLa: [133, 91, 20],
  other: [115, 66, 66],
};

/** The stored word order is authoritative, including unlabelled manual words. */
export function playbackWords(lines: CalibrationLine[]): PlaybackWord[] {
  return [...lines]
    .filter((line) => !line.readonly)
    .sort((a, b) => a.page_number - b.page_number || a.line_number - b.line_number)
    .flatMap((line) => line.words.map((word, wordIndex) => ({ line, word, wordIndex })));
}

export function wordBlobs(entry: PlaybackWord): CalibrationBlob[] {
  if (entry.word.word_id === null) return [];
  return entry.line.blobs
    .filter(
      (blob) =>
        (blob.role === "body" || blob.role === "mark") &&
        blob.allocations.some((allocation) => allocation.word_id === entry.word.word_id),
    )
    .sort((a, b) => b.x + b.w - (a.x + a.w) || a.y - b.y || a.id - b.id);
}

export function inkColor(blob: CalibrationBlob, type: string, distinguishTypes: boolean): RGB {
  return blob.role === "body"
    ? BODY_INK
    : distinguishTypes
      ? (TYPE_INK[type] ?? MARK_INK)
      : MARK_INK;
}

/** Shared ink is allocated by the internal cut, not painted whole for both words.
 * Unshared owned ink outside a word's box stays visible: that discrepancy matters. */
export function belongsAt(blob: CalibrationBlob, word: CalibrationWord, pageX: number): boolean {
  if (word.word_id === null || !blob.allocations.some((a) => a.word_id === word.word_id))
    return false;
  return blob.allocations.length <= 1 || (pageX >= word.end_x && pageX < word.start_x);
}

export function paintPlaybackInk(
  ids: Uint32Array,
  width: number,
  line: CalibrationLine,
  word: CalibrationWord | null,
  types: ReadonlyMap<number, string>,
  distinguishTypes: boolean,
  dimOthers: boolean,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(ids.length * 4);
  const blobs = new Map(line.blobs.map((blob) => [blob.id, blob]));
  for (let i = 0; i < ids.length; i++) {
    const blob = blobs.get(ids[i]);
    if (!blob) continue;
    const active = word && belongsAt(blob, word, line.bbox.x + (i % width));
    const color = active
      ? inkColor(blob, types.get(blob.id) ?? "", distinguishTypes)
      : [110, 110, 110];
    pixels[i * 4] = color[0];
    pixels[i * 4 + 1] = color[1];
    pixels[i * 4 + 2] = color[2];
    pixels[i * 4 + 3] = active ? 255 : dimOthers ? 70 : 230;
  }
  return pixels;
}

/** Crop includes owned marks and fragments even when a dragged edge excludes them. */
export function wordCrop(entry: PlaybackWord) {
  const { line, word } = entry;
  const blobs = wordBlobs(entry);
  const left = Math.min(word.end_x, ...blobs.map((b) => b.x));
  const right = Math.max(word.start_x, ...blobs.map((b) => b.x + b.w));
  const top = blobs.length ? Math.min(...blobs.map((b) => b.y)) : line.bbox.y;
  const bottom = blobs.length
    ? Math.max(...blobs.map((b) => b.y + b.h))
    : line.bbox.y + line.bbox.h;
  const x = Math.max(0, left - line.bbox.x - 12);
  const y = Math.max(0, top - line.bbox.y - 12);
  return {
    x,
    y,
    w: Math.max(1, Math.min(line.bbox.w, right - line.bbox.x + 12) - x),
    h: Math.max(1, Math.min(line.bbox.h, bottom - line.bbox.y + 12) - y),
  };
}

/** Pixel-based navigation when boxes overlap. Fall back to the saved word box
 * only on background; an unassigned blob must not pretend to belong to a word. */
export function wordAtPixel(
  entries: PlaybackWord[],
  line: CalibrationLine,
  blobId: number,
  pageX: number,
): number {
  const blob = line.blobs.find((candidate) => candidate.id === blobId);
  return entries.findIndex(
    (entry) =>
      entry.line.snapshot_id === line.snapshot_id &&
      (blob
        ? belongsAt(blob, entry.word, pageX)
        : pageX >= entry.word.end_x && pageX < entry.word.start_x),
  );
}

import type { CalibrationBlob, CalibrationLine, CalibrationWord } from "./types.ts";

export type PlaybackWord = { line: CalibrationLine; word: CalibrationWord; wordIndex: number };
export type RGB = readonly [number, number, number];

export const BODY_INK: RGB = [0, 0, 0];
// Mark inks sit mid-tone (relative luminance ~0.14–0.25): about 3.4–5:1
// against both the black body ink and the white background.
export const MARK_INK: RGB = [222, 40, 110];
export const TYPE_INK: Record<string, RGB> = {
  fatha: [214, 90, 0],
  damma: [205, 40, 130],
  kasra: [0, 150, 105],
  sukun: [140, 80, 210],
  shadda: [170, 118, 0],
  tanween: [225, 50, 50],
  madda: [170, 55, 155],
  daggerAlif: [105, 145, 0],
  smallWaw: [190, 85, 105],
  smallYa: [150, 90, 190],
  smallMeem: [120, 125, 30],
  smallLetter: [190, 85, 105],
  ijamDot: [40, 120, 220],
  hamza: [190, 95, 0],
  kafCurl: [150, 110, 60],
  wasla: [0, 150, 135],
  waqfSili: [195, 45, 45],
  waqfQili: [165, 70, 130],
  waqfJim: [90, 150, 35],
  waqfMim: [155, 90, 185],
  waqfLa: [180, 125, 30],
  other: [160, 95, 95],
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

/** Crop includes owned marks and fragments even where the box stops short of them —
 * at the middle of a body two words share. */
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

/** The word under a point of the page (page px): its line's height, its box's x span.
 * The index into `entries`, or -1. */
export function wordAtPoint(entries: PlaybackWord[], x: number, y: number): number {
  return entries.findIndex(
    ({ line, word }) =>
      word.word_id !== null &&
      y >= line.bbox.y &&
      y < line.bbox.y + line.bbox.h &&
      x >= word.end_x &&
      x < word.start_x,
  );
}

// The joining rules of the server's core/text/arabic.py — the one source; keep these
// equal to its NON_JOINERS, NON_RECEIVERS and MARKS.
const NON_JOINERS = new Set("اأإآٱدذرزوؤةءٲٳٵٶٷٮۃ");
const NON_RECEIVERS = new Set("ءٴ");
function isMarkChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x0610 && c <= 0x061a) ||
    (c >= 0x064b && c <= 0x065f) ||
    c === 0x0670 ||
    (c >= 0x06d6 && c <= 0x06ed) ||
    c === 0x0640
  );
}

/** A word's text cut into the pieces its ink prints (PAWs), right to left, each letter
 * keeping the marks written on it: بِسْمِ is one piece, ٱلرَّحْمَٰنِ three. */
export function piecesOf(text: string): string[] {
  const letters: string[] = [];
  for (const ch of text) {
    if (isMarkChar(ch) && letters.length) letters[letters.length - 1] += ch;
    else letters.push(ch);
  }
  const pieces: string[] = [];
  let current = "";
  for (const letter of letters) {
    const base = [...letter][0];
    if (NON_RECEIVERS.has(base) && current) {
      pieces.push(current);
      current = "";
    }
    current += letter;
    if (NON_JOINERS.has(base)) {
      pieces.push(current);
      current = "";
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Which pieces of its word's text each body prints: the bodies right to left, each
 * taking as many pieces as the PAWs it is given for this word — none for a broken
 * fragment, two for two printed touching. `first` is the first piece's number from 1. */
export function bodyPieces(
  entry: PlaybackWord,
): Map<number, { pieces: string[]; first: number; share: number; total: number }> {
  const pieces = piecesOf(entry.word.text);
  const found = new Map<
    number,
    { pieces: string[]; first: number; share: number; total: number }
  >();
  let at = 0;
  for (const blob of wordBlobs(entry)) {
    if (blob.role !== "body") continue;
    const share =
      blob.allocations.find((allocation) => allocation.word_id === entry.word.word_id)?.paws ?? 0;
    found.set(blob.id, {
      pieces: pieces.slice(at, at + share),
      first: at + 1,
      share,
      total: pieces.length,
    });
    at += share;
  }
  return found;
}

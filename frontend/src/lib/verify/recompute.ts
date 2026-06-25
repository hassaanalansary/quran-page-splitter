// Renumbering + segment-derivation logic for the verify page.
//
// All editing flows go through `recomputeAll(results)`:
//   1. Walk pages/lines in reading order.
//   2. Each sura_header's stored `sura_number` is trusted as the definitive
//      sura for that header.  When the user changes one, `setSuraNumber` in
//      verify.tsx propagates the change to all subsequent headers.
//   3. basmala + text lines inherit the current sura.
//   4. For text lines, segments are derived from line_bbox + separator_cuts
//      (Arabic right-to-left order) and assigned consecutive aya numbers,
//      resetting to 1 at every sura boundary.

import { SURAS, getSura } from "@/lib/data/suras";
import { genId, type Line, type Results, type Segment } from "./types";

function suraInfo(n: number) {
  const clamped = Math.max(1, Math.min(114, Math.round(n)));
  return getSura(clamped);
}

/**
 * Drop-threshold for trailing/leading sliver segments (e.g. an aya separator
 * lying right at the line's edge). Anything narrower than this fraction of the
 * line's width is removed from the segment list — but its separator stays in
 * `separator_cuts` so it keeps rendering and can be dragged back inward.
 *
 * Tune this constant if the threshold proves wrong in practice.
 */
export const MIN_SEGMENT_WIDTH_FRACTION = 0.01;

/** Derive segments for a text line from its bbox + separator cuts.
 * Also returns the clipped cuts list in its original order so separator drag
 * identity stays stable while separators at the edge remain preserved. */
export function deriveSegmentsAndCuts(line: Line): {
  segments: Segment[];
  cuts: number[];
} {
  if (line.type !== "text") return { segments: [], cuts: [] };
  const bbox = line.line_bbox;
  const rightEdge = bbox.x + bbox.w;
  const leftEdge = bbox.x;
  const minW = bbox.w * MIN_SEGMENT_WIDTH_FRACTION;

  // Preserve separator identity/order for dragging. Segment derivation uses a
  // sorted copy, but the stored array must not be re-sorted on every pointer
  // move or a dragged separator can start overwriting its neighbours.
  const maxCut = Math.max(leftEdge, rightEdge - 1);
  const cuts = [...(line.separator_cuts ?? [])]
    .map((c) => Math.round(c))
    .filter((c) => Number.isFinite(c))
    .map((c) => Math.max(leftEdge, Math.min(maxCut, c)));
  const sortedCuts = [...cuts].sort((a, b) => a - b);

  // Boundaries right→left (Arabic reading order).
  const boundaries = [rightEdge, ...sortedCuts.slice().reverse(), leftEdge];
  const oldSegs = line.segments ?? [];

  type Raw = { left: number; right: number; w: number; dropped: boolean; idx: number };
  const raw: Raw[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const right = boundaries[i];
    const left = boundaries[i + 1];
    const w = Math.max(0, right - left);
    raw.push({ left, right, w, dropped: w < minW, idx: i });
  }

  // Build segments, handling deleted ranges.
  const deletedRanges = normalizeDeletedRanges(line);

  const out: Segment[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].dropped) continue;

    const segBbox = { x: raw[i].left, y: bbox.y, w: Math.max(1, raw[i].w), h: bbox.h };

    // Skip segments that match a deleted range.
    if (isDeletedSegment(segBbox, deletedRanges)) continue;

    // A segment is complete when its left boundary is a separator cut. This
    // remains true even if that cut is exactly at the left edge and the tiny
    // segment after it is dropped by MIN_SEGMENT_WIDTH_FRACTION.
    const hasSep = i + 1 < boundaries.length - 1;

    const reused = oldSegs[i];
    out.push({
      id: reused?.id ?? genId("seg"),
      sura_number: 0,
      sura_name: "",
      aya_number: 0,
      is_continuation: !hasSep,
      has_separator: hasSep,
      bbox: segBbox,
    });
  }

  return { segments: out, cuts };
}

/** @deprecated kept for backwards-compat. */
export function deriveSegments(line: Line): Segment[] {
  return deriveSegmentsAndCuts(line).segments;
}

export function recomputeAll(
  results: Results,
  startSuraOverride?: number,
  startAyaOverride?: number,
): Results {
  const startSura = startSuraOverride ?? results.start_sura ?? 1;
  const startAya = startAyaOverride ?? results.start_aya ?? 1;

  let suraNumber = startSura;
  let ayaNumber = startAya;

  const pages = results.pages.map((page) => {
    const lines = page.lines.map((line, idx) => {
      const newLine: Line = {
        ...line,
        line_number: idx + 1,
      };

      if (line.type === "sura_header") {
        // Trust the stored sura_number — setSuraNumber propagates changes.
        suraNumber = line.sura_number ?? suraNumber;
        const info = suraInfo(suraNumber);
        newLine.sura_number = info.number;
        newLine.sura_name = info.name;
        newLine.sura_transliteration = info.transliteration;
        // Aya resets after a sura header.
        ayaNumber = 1;
        // Clean text-only fields off non-text lines.
        newLine.segments = undefined;
        newLine.separator_cuts = undefined;
        newLine.deleted_segment_ranges = undefined;
        return newLine;
      }

      if (line.type === "basmala") {
        const info = suraInfo(suraNumber);
        newLine.sura_number = info.number;
        newLine.sura_name = info.name;
        // Clean text-only fields off non-text lines.
        newLine.segments = undefined;
        newLine.separator_cuts = undefined;
        newLine.deleted_segment_ranges = undefined;
        return newLine;
      }

      // text
      const { segments: segs, cuts } = deriveSegmentsAndCuts(newLine);
      const info = suraInfo(suraNumber);
      for (const seg of segs) {
        seg.sura_number = info.number;
        seg.sura_name = info.name;
        seg.aya_number = ayaNumber;
        if (seg.has_separator) ayaNumber += 1;
      }
      newLine.segments = segs;
      // Persist clipped cuts without re-sorting; drag identity depends on order.
      newLine.separator_cuts = cuts;
      // Preserve deleted ranges.
      newLine.deleted_segment_ranges = normalizeDeletedRanges(line);
      return newLine;
    });

    return { ...page, lines };
  });

  // Recompute end_sura/end_aya for the export.
  const lastPage = pages[pages.length - 1];
  let endSura = startSura;
  let endAya = startAya;
  if (lastPage) {
    for (let i = lastPage.lines.length - 1; i >= 0; i -= 1) {
      const l = lastPage.lines[i];
      if (l.type === "text" && l.segments && l.segments.length) {
        const last = l.segments[l.segments.length - 1];
        endSura = last.sura_number;
        endAya = last.aya_number;
        break;
      }
      if (l.type === "sura_header" && l.sura_number) {
        endSura = l.sura_number;
        endAya = 1;
        break;
      }
    }
  }

  return {
    ...results,
    start_sura: startSura,
    start_aya: startAya,
    end_sura: endSura,
    end_aya: endAya,
    pages,
  };
}

// ────────────────── deleted-segment-range helpers ──────────────────

function normalizeDeletedRanges(line: Line): { x: number; w: number }[] {
  const raw = line.deleted_segment_ranges;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r): r is { x: number; w: number } =>
        typeof r === "object" &&
        r !== null &&
        typeof r.x === "number" &&
        typeof r.w === "number" &&
        Number.isFinite(r.x) &&
        Number.isFinite(r.w) &&
        r.w > 0,
    )
    .map((r) => ({ x: Math.round(r.x), w: Math.round(r.w) }));
}

function isDeletedSegment(
  bbox: { x: number; w: number },
  ranges: { x: number; w: number }[],
): boolean {
  const start = Math.round(bbox.x);
  const end = start + Math.round(bbox.w);
  return ranges.some((r) => start === r.x && end === r.x + r.w);
}

export const ALL_SURAS = SURAS;

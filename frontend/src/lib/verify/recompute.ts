// Renumbering + segment-derivation logic for the verify page.
//
// All editing flows go through `recomputeAll(results, startSura, startAya)`:
//   1. Walk pages/lines in reading order.
//   2. Each sura_header anchors a new sura; the FIRST header keeps its assigned
//      number (so the user can override it), subsequent headers are previous+1.
//   3. basmala + text lines inherit the current sura.
//   4. For text lines, segments are derived from line_bbox + separator_cuts
//      (Arabic right-to-left order) and assigned consecutive aya numbers,
//      resetting at every sura boundary.

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

/** Derive segments for a text line from its bbox + sorted separator cuts.
 * Also returns the canonical cuts list (clipped to bbox, sorted asc) so
 * separators at the very edge of the line are preserved. */
export function deriveSegmentsAndCuts(line: Line): {
  segments: Segment[];
  cuts: number[];
} {
  if (line.type !== "text") return { segments: [], cuts: [] };
  const bbox = line.line_bbox;
  const rightEdge = bbox.x + bbox.w;
  const leftEdge = bbox.x;
  const minW = bbox.w * MIN_SEGMENT_WIDTH_FRACTION;

  const cuts = [...(line.separator_cuts ?? [])]
    .map((c) => Math.round(c))
    // Allow cuts AT the edges — a separator at the end of a line is valid.
    .filter((c) => c >= leftEdge && c <= rightEdge)
    .sort((a, b) => a - b);

  // Boundaries right→left (Arabic reading order).
  const boundaries = [rightEdge, ...cuts.slice().reverse(), leftEdge];
  const oldSegs = line.segments ?? [];
  type Raw = { left: number; right: number; w: number; dropped: boolean; idx: number };
  const raw: Raw[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const right = boundaries[i];
    const left = boundaries[i + 1];
    const w = Math.max(0, right - left);
    raw.push({ left, right, w, dropped: w < minW, idx: i });
  }

  const out: Segment[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].dropped) continue;
    // Is there a real separator (not the left edge) between this segment and
    // the next surviving segment to the left?
    let hasSep = false;
    let j = i + 1;
    while (j < raw.length && raw[j].dropped) j += 1;
    if (j < raw.length) {
      const leftBoundaryIsCut = i + 1 < boundaries.length - 1;
      hasSep = leftBoundaryIsCut;
    }
    const reused = oldSegs[i];
    out.push({
      id: reused?.id ?? genId("seg"),
      sura_number: 0,
      sura_name: "",
      aya_number: 0,
      is_continuation: !hasSep,
      has_separator: hasSep,
      bbox: { x: raw[i].left, y: bbox.y, w: Math.max(1, raw[i].w), h: bbox.h },
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
  let firstHeaderSeen = false;
  let lastSuraNumber = suraNumber;

  const pages = results.pages.map((page) => {
    const lines = page.lines.map((line, idx) => {
      const newLine: Line = {
        ...line,
        line_number: idx + 1,
      };

      if (line.type === "sura_header") {
        if (!firstHeaderSeen) {
          // First header anchors: keep its existing number (or fall back to startSura).
          suraNumber = line.sura_number ?? startSura;
          firstHeaderSeen = true;
        } else {
          suraNumber = lastSuraNumber + 1;
        }
        const info = suraInfo(suraNumber);
        newLine.sura_number = info.number;
        newLine.sura_name = info.name;
        newLine.sura_transliteration = info.transliteration;
        lastSuraNumber = info.number;
        // Aya resets after a sura header (basmala/first text starts at 1).
        ayaNumber = info.number === startSura ? startAya : 1;
        return newLine;
      }

      if (line.type === "basmala") {
        const info = suraInfo(suraNumber);
        newLine.sura_number = info.number;
        newLine.sura_name = info.name;
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
      // Persist the canonical clipped+sorted cut list (INCLUDING edge cuts).
      newLine.separator_cuts = cuts;
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

export const ALL_SURAS = SURAS;

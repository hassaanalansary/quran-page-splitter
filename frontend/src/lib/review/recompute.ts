// Segment derivation + global renumbering, mirroring the server exactly
// (backend/api/services/coordinates.py::renumber_from):
//   - seed = store.start (the first page's entry state);
//   - a sura_header line does `sura += 1; aya = 1` ONLY when the running aya != 1;
//   - besmella takes the running sura;
//   - text segments take the running aya; has_separator increments it.

import type { Rect, Sura } from "@/lib/api";

import type { EditLine, EditPage, ReviewStore } from "./model";

/** Slivers narrower than this fraction of the line width are dropped from the
 * segment list, but their cut is preserved (rendered + draggable back inward). */
export const MIN_SEGMENT_WIDTH_FRACTION = 0.01;

export type DerivedSegment = {
  bbox: Rect; // x/w from the cut walk, y/h from the line
  has_separator: boolean;
  sura: number;
  aya: number;
  overflow: boolean; // aya exceeded the sura's count (per current qiraa)
};

export type DerivedLine = {
  uid: string;
  line_number: number; // 1-based position on the page
  type: EditLine["type"];
  bbox: Rect;
  cuts: number[]; // clamped, original order (drag identity)
  sura: number; // running sura (headers/besmella show this)
  segments: DerivedSegment[]; // text lines only
  boundaryWarning: boolean; // header incremented while previous sura ended at the wrong aya
};

export type DerivedPage = {
  page_number: number;
  lines: DerivedLine[];
  entry: { sura: number; aya: number };
  exit: { sura: number; aya: number };
  hasHeader: boolean;
  warnings: number;
};

export type Derived = {
  pages: DerivedPage[];
  end: { sura: number; aya: number };
  totalWarnings: number;
};

/** Port of the old deriveSegmentsAndCuts: boundaries right→left from the
 * clamped cuts; a segment has a separator iff its LEFT boundary is a cut. */
export function deriveGeometry(
  bbox: Rect,
  cuts: number[],
): { spans: { x: number; w: number; hasSep: boolean }[]; cuts: number[] } {
  const rightEdge = bbox.x + bbox.w;
  const leftEdge = bbox.x;
  const minW = bbox.w * MIN_SEGMENT_WIDTH_FRACTION;
  const maxCut = Math.max(leftEdge, rightEdge - 1);

  const clamped = cuts
    .map((c) => Math.round(c))
    .filter((c) => Number.isFinite(c))
    .map((c) => Math.max(leftEdge, Math.min(maxCut, c)));
  const sorted = [...clamped].sort((a, b) => a - b);

  const boundaries = [rightEdge, ...sorted.slice().reverse(), leftEdge];
  const spans: { x: number; w: number; hasSep: boolean }[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const right = boundaries[i];
    const left = boundaries[i + 1];
    const w = right - left;
    if (w < minW) continue; // sliver dropped; its cut stays in `clamped`
    spans.push({ x: left, w: Math.max(1, w), hasSep: i + 1 < boundaries.length - 1 });
  }
  return { spans, cuts: clamped };
}

export function recompute(store: ReviewStore, suras?: Sura[]): Derived {
  const countOf = (n: number) => suras?.find((s) => s.number === n)?.aya_count ?? null;
  let sura = store.start.sura;
  let aya = store.start.aya;
  let totalWarnings = 0;

  const pages = store.pages.map((page, i) => {
    // Island seeding: a page starts a new island when it's the first page or the
    // previous page has no data (a gap stops numbering propagation). At an island
    // start the running counter resets to the page's run seed (page 1 uses the
    // document start), so the first processed page after a gap begins where its
    // processing run specified — not carried over across the gap.
    const prev = i > 0 ? store.pages[i - 1] : null;
    const islandStart = i === 0 || (prev != null && prev.lines.length === 0);
    if (islandStart) {
      const seed = i === 0 ? store.start : (page.run_start ?? { sura: 1, aya: 1 });
      sura = seed.sura;
      aya = seed.aya;
    }
    const entry = { sura, aya };
    let warnings = 0;
    let hasHeader = false;

    const lines = page.lines.map((line, idx): DerivedLine => {
      let boundaryWarning = false;
      if (line.type === "sura_header") {
        hasHeader = true;
        if (aya !== 1) {
          const expected = countOf(sura);
          boundaryWarning = expected != null && aya - 1 !== expected;
        }
        // Explicit sura anchors here; otherwise auto-advance to the next sura
        // (but only when the previous one has actually started — aya != 1).
        if (line.sura != null) {
          sura = line.sura;
          aya = 1;
        } else if (aya !== 1) {
          sura += 1;
          aya = 1;
        }
      }
      const base: DerivedLine = {
        uid: line.uid,
        line_number: idx + 1,
        type: line.type,
        bbox: line.bbox,
        cuts: line.cuts,
        sura,
        segments: [],
        boundaryWarning,
      };
      if (boundaryWarning) warnings += 1;
      if (line.type !== "text") return base;

      const { spans, cuts } = deriveGeometry(line.bbox, line.cuts);
      const max = countOf(sura);
      base.cuts = cuts;
      base.segments = spans.map((span) => {
        const overflow = max != null && aya > max;
        if (overflow) warnings += 1;
        const seg: DerivedSegment = {
          bbox: { x: span.x, y: line.bbox.y, w: span.w, h: line.bbox.h },
          has_separator: span.hasSep,
          sura,
          aya,
          overflow,
        };
        if (span.hasSep) aya += 1;
        return seg;
      });
      return base;
    });

    totalWarnings += warnings;
    return {
      page_number: page.page_number,
      lines,
      entry,
      exit: { sura, aya },
      hasHeader,
      warnings,
    };
  });

  return { pages, end: { sura, aya: Math.max(1, aya - 1) }, totalWarnings };
}

/** One aya of a page with every rect it occupies — the shape the downstream
 * app consumes (mirrors `services/export.py::coordinates_json`). */
export type AyaGroup = {
  key: string;
  sura: number;
  aya: number;
  rects: Rect[];
};

/** Group a derived page's segments into ayat, in reading order. An aya that
 * spans several lines (or segments) collects all of their boxes. */
export function ayaGroups(page: DerivedPage | null | undefined): AyaGroup[] {
  if (!page) return [];
  const ordered: AyaGroup[] = [];
  const byKey = new Map<string, AyaGroup>();
  for (const line of page.lines) {
    for (const segment of line.segments) {
      const key = `${segment.sura}:${segment.aya}`;
      let group = byKey.get(key);
      if (!group) {
        group = { key, sura: segment.sura, aya: segment.aya, rects: [] };
        byKey.set(key, group);
        ordered.push(group);
      }
      group.rects.push(segment.bbox);
    }
  }
  return ordered;
}

/** API payload for one page (bulk save). Numbering comes from `derived`. */
export function toApiPage(page: EditPage, derived: DerivedPage) {
  return {
    page_number: page.page_number,
    bbox: page.bbox,
    lines: derived.lines.map((line) => ({
      line_number: line.line_number,
      type: line.type,
      sura_number: line.sura,
      bbox_x: line.bbox.x,
      bbox_y: line.bbox.y,
      bbox_w: line.bbox.w,
      bbox_h: line.bbox.h,
      segments: line.segments.map((seg, i) => ({
        segment_order: i + 1,
        bbox_x: seg.bbox.x,
        bbox_w: seg.bbox.w,
        has_separator: seg.has_separator,
        aya_number: seg.aya,
      })),
    })),
  };
}

/**
 * Numbering dirty check, the companion to `pageSignature`.
 *
 * A page's numbers are a pure function of its entry counter and its structure,
 * so when the structure is unchanged the entry alone decides whether the numbers
 * the server holds are still right. That matters because renumbering from a sura
 * header shifts every later page's suras without touching a single bbox — those
 * pages are structurally clean but their saved numbering is now stale, and
 * without this they would never be sent.
 */
export function entrySignature(page: DerivedPage): string {
  return `${page.entry.sura}:${page.entry.aya}`;
}

/** Structural dirty check against a baseline snapshot (numbering is derived,
 * so only structure matters: line count/order, types, bboxes, cuts). */
export function pageSignature(page: EditPage): string {
  return JSON.stringify(
    page.lines.map((l) => [l.type, l.bbox.x, l.bbox.y, l.bbox.w, l.bbox.h, l.cuts, l.sura ?? null]),
  );
}

/** Stored-cut index whose clamped position is nearest `boundaryX`, or -1.
 * Used to merge a segment away by removing exactly one cut, robust to cut
 * order and dropped slivers (value match, not index arithmetic). */
export function cutIndexAt(bbox: Rect, cuts: number[], boundaryX: number): number {
  const leftEdge = bbox.x;
  const maxCut = Math.max(leftEdge, bbox.x + bbox.w - 1);
  let best = -1;
  let bestDist = Infinity;
  cuts.forEach((c, i) => {
    const clamped = Math.max(leftEdge, Math.min(maxCut, Math.round(c)));
    const dist = Math.abs(clamped - boundaryX);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** Pages spanned by the sura that ENDS on `pageNumber` (its header page — or
 * the document start — through `pageNumber`). Used for auto-review. */
export function suraSpanPages(derived: Derived, pageNumber: number): number[] {
  const idx = derived.pages.findIndex((p) => p.page_number === pageNumber);
  if (idx < 0 || !derived.pages[idx].hasHeader) return [];
  const span: number[] = [];
  for (let i = idx - 1; i >= 0; i -= 1) {
    span.unshift(derived.pages[i].page_number);
    if (derived.pages[i].hasHeader) break;
  }
  return span;
}

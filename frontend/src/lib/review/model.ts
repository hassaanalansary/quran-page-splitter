// Editable in-memory model of the whole review session.
// Segments are NEVER stored — they are derived from line bbox + separator cuts.

import type { ReviewData, ReviewLine, ReviewPage, Rect } from "@/lib/api";

export type EditLineType = "text" | "sura_header" | "besmella";

export type EditLine = {
  /** Client identity for selection/keys (line_number is derived by position). */
  uid: string;
  type: EditLineType;
  bbox: Rect;
  /** Separator x-cuts (text lines only). Order-stable for drag identity. */
  cuts: number[];
  /** Explicit sura for a sura_header line — anchors the running sura from here.
   * Undefined → auto-increment (next sura). */
  sura?: number;
};

export type EditPage = {
  page_number: number;
  bbox: Rect;
  lines: EditLine[];
  reviewed: boolean;
  /** The (sura, aya) this page's run began at — the seed when it starts an
   * island (a gap breaks propagation). null for manual/unprocessed pages. */
  run_start: { sura: number; aya: number } | null;
};

export type ReviewStore = {
  start: { sura: number; aya: number };
  pages: EditPage[];
};

export function genId(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Edit one line (`null` deletes it), then drop the explicit sura anchor from
 * every sura_header AFTER it — the rest of that page and all later pages.
 *
 * Processing stamps every header it finds with a sura number, and `recompute`
 * lets an explicit anchor beat the running counter. So a header inserted or
 * corrected part-way through used to renumber nothing: the very next header
 * still asserted its old sura and pulled the count straight back. Releasing the
 * later anchors lets auto-advance carry the correction to the end of the mushaf,
 * which is what renumbering from a header is supposed to mean.
 *
 * Anchors are client-side only — `toApiPage` saves the derived number — so
 * clearing them loses nothing that has to be persisted.
 */
export function reflowFrom(
  store: ReviewStore,
  uid: string,
  edit: (line: EditLine) => EditLine | null,
): ReviewStore {
  let passed = false;
  return {
    ...store,
    pages: store.pages.map((page) => {
      // `store.pages` is in page order, so nothing before the edited line is
      // ever reached with `passed` set.
      let changed = false;
      const lines: EditLine[] = [];
      for (const line of page.lines) {
        if (line.uid === uid) {
          passed = true;
          changed = true;
          const next = edit(line);
          if (next) lines.push(next);
          continue;
        }
        if (passed && line.type === "sura_header" && line.sura !== undefined) {
          changed = true;
          lines.push({ ...line, sura: undefined });
          continue;
        }
        lines.push(line);
      }
      return changed ? { ...page, lines } : page;
    }),
  };
}

/** A placeholder crop box for pages with no server data yet (manual pages). */
const DEFAULT_BBOX: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** One page's edit model from a server review-data page. Used both when building
 * the store and when reconciling a saved page from the bulk-save response. */
export function editPageFromApiPage(p: ReviewPage): EditPage {
  return {
    page_number: p.page_number,
    bbox: p.bbox ?? DEFAULT_BBOX,
    reviewed: p.reviewed,
    run_start: p.run_start,
    lines: p.lines.map((l: ReviewLine) => ({
      uid: genId("line"),
      type: l.type,
      bbox: { x: l.bbox_x, y: l.bbox_y, w: l.bbox_w, h: l.bbox_h },
      cuts: l.type === "text" ? (l.cuts ?? []) : [],
      // Existing sura headers anchor to their stored sura (editable in review).
      sura: l.type === "sura_header" && l.sura_number != null ? l.sura_number : undefined,
    })),
  };
}

/** Build the editing store for EVERY logical page 1..`logicalCount`. Pages the
 * server hasn't processed become empty, editable pages (manual processing). */
export function fromApi(data: ReviewData, logicalCount: number): ReviewStore {
  const byNumber = new Map(data.pages.map((p) => [p.page_number, p]));
  const pages: EditPage[] = [];
  for (let n = 1; n <= Math.max(logicalCount, 1); n += 1) {
    const p = byNumber.get(n);
    pages.push(
      p
        ? editPageFromApiPage(p)
        : { page_number: n, bbox: DEFAULT_BBOX, reviewed: false, run_start: null, lines: [] },
    );
  }
  return { start: data.start, pages };
}

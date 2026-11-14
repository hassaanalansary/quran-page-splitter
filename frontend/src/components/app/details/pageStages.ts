import type { PageSummary } from "@/lib/api";
import type { CalibrationPageState } from "@/lib/calibration/types";

/**
 * The stages a page goes through, in pipeline order, as the hub tracks them.
 *
 * Each is tracked on its own: a page can have a later stage done and an earlier one
 * not — cuts checked on a page never reviewed, Ink run before the cuts were checked —
 * so none is read off another, and each count is every page that has done it.
 * `step` is where a page is worked on for it (Process has no page of its own, so a
 * processed page opens in Review).
 */
export const PAGE_STAGES = [
  { key: "processed", fill: "bg-lapis", label: "details.stage_processed", step: "review" },
  { key: "reviewed", fill: "bg-done", label: "details.stage_reviewed", step: "review" },
  {
    key: "linesChecked",
    fill: "bg-gold",
    label: "details.stage_linesChecked",
    step: "finalize",
  },
  {
    key: "inkProcessed",
    fill: "bg-mark-text",
    label: "details.stage_inkProcessed",
    step: "ink",
  },
] as const;

export type PageStage = (typeof PAGE_STAGES)[number];
export type PageStageKey = PageStage["key"];

/** The pages the Ink step has processed (drafted or confirmed). */
export function findInkProcessedPages(pages: CalibrationPageState[] | undefined): Set<number> {
  return new Set((pages ?? []).filter((page) => page.processed).map((page) => page.page));
}

/** The stages one page has done. `row` is its summary, absent until it is processed. */
export function findDoneStages(
  row: PageSummary | undefined,
  inkProcessed: boolean,
): Set<PageStageKey> {
  const done = new Set<PageStageKey>();
  if (row) done.add("processed");
  if (row?.reviewed) done.add("reviewed");
  if (row?.lines_finalized) done.add("linesChecked");
  if (inkProcessed) done.add("inkProcessed");
  return done;
}

/** How many pages have done each stage, each counted on its own. */
export function countDoneStages(
  summaries: PageSummary[] | undefined,
  inkPages: Set<number>,
): Record<PageStageKey, number> {
  const rows = summaries ?? [];
  return {
    processed: rows.length,
    reviewed: rows.filter((row) => row.reviewed).length,
    linesChecked: rows.filter((row) => row.lines_finalized).length,
    inkProcessed: inkPages.size,
  };
}

/** A sort key that puts pages in the order of how far along they are: by their
 * furthest stage, then by the ones before it. */
export function rankDoneStages(done: Set<PageStageKey>): number {
  return PAGE_STAGES.reduce(
    (rank, stage, index) => rank + (done.has(stage.key) ? 2 ** index : 0),
    0,
  );
}

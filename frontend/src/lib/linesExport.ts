/**
 * Exporting many pages' line images, page by page, in the background.
 *
 * Each page is its own short request (`exportLines`); what runs long is the walk
 * over hundreds of them. The walk lives here, at module level, rather than in the
 * Export tab, so leaving the tab — or the mushaf — does not lose it: its progress
 * shows in a toast that follows the person around the app, with a Stop button.
 * Closing or reloading the browser tab does end it, so the page asks first while
 * one is running.
 *
 * Kept in the browser on purpose: a server job would hold the mushaf's one run
 * and the person's one job slot (`api/services/jobs.py`), and so block processing
 * pages in Ink for as long as the export lasts.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import i18n from "@/i18n/config";
import { ApiError, exportLines, queryKeys } from "@/lib/api";

export type LinesExportRun = {
  mushafId: string;
  total: number;
  /** Pages walked so far, failed ones included. */
  done: number;
  failed: number[];
  /** Stop was pressed: the run ends once the page in hand is done. */
  stopping: boolean;
};

const TOAST_ID = "lines-export";
/** How often the export counts on the Export tab refresh during a run, in pages. */
const REFRESH_COUNTS_EVERY = 10;
/** Pages failing one after another mean the server is down or the session is gone,
 * not a bad page: the run stops rather than walk the rest to the same error. */
const MAX_FAILURES_IN_A_ROW = 3;
/** Failed pages named in the closing toast; the rest are counted. */
const FAILED_PAGES_SHOWN = 10;

let current: LinesExportRun | null = null;
const listeners = new Set<() => void>();

function publishRun(next: LinesExportRun | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribeToRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readRun(): LinesExportRun | null {
  return current;
}

/** The export running now, wherever it was started; null when none is. */
export function useLinesExport(): LinesExportRun | null {
  return useSyncExternalStore(subscribeToRun, readRun);
}

/** Ask the running export to end after the page in hand. */
export function stopLinesExport(): void {
  if (current && !current.stopping) {
    publishRun({ ...current, stopping: true });
    showProgress(current);
  }
}

function askBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

function showProgress(run: LinesExportRun): void {
  toast.loading(i18n.t("details.ex_runProgress", { done: run.done, total: run.total }), {
    id: TOAST_ID,
    description: run.stopping ? i18n.t("details.ex_runStopping") : i18n.t("details.ex_runNote"),
    action: run.stopping
      ? undefined
      : {
          label: i18n.t("details.ex_runStop"),
          onClick: (event) => {
            event.preventDefault(); // keep the toast: it goes on reporting
            stopLinesExport();
          },
        },
  });
}

function listFailedPages(failed: number[]): string {
  const shown = failed.slice(0, FAILED_PAGES_SHOWN).join(", ");
  const more = failed.length - FAILED_PAGES_SHOWN;
  return more > 0 ? i18n.t("details.ex_runFailedMore", { pages: shown, count: more }) : shown;
}

function showOutcome(run: LinesExportRun, lastError: string | null, gaveUp: boolean): void {
  // The same toast, turned from loading into its outcome: what it carried while
  // loading is cleared, and it closes on its own again.
  const options = { id: TOAST_ID, duration: 8000, description: undefined, action: undefined };
  const exported = run.done - run.failed.length;
  if (gaveUp) {
    toast.error(i18n.t("details.ex_runGaveUp", { done: exported, total: run.total }), {
      ...options,
      description: lastError ?? undefined,
    });
  } else if (run.failed.length > 0) {
    toast.warning(
      i18n.t("details.ex_runSomeFailed", {
        done: exported,
        total: run.total,
        pages: listFailedPages(run.failed),
      }),
      { ...options, description: lastError ?? undefined },
    );
  } else if (run.done < run.total) {
    toast.info(i18n.t("details.ex_runStopped", { done: run.done, total: run.total }), options);
  } else {
    toast.success(i18n.t("details.ex_exportedToast", { count: run.total }), options);
  }
}

function refreshExportCounts(queryClient: QueryClient, mushafId: string): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.stats(mushafId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
}

/** Export the line images of `pages`, one page after another, in the background.
 * One run at a time, across every mushaf. */
export async function startLinesExport({
  mushafId,
  pages,
  queryClient,
}: {
  mushafId: string;
  pages: number[];
  queryClient: QueryClient;
}): Promise<void> {
  if (current) {
    toast.info(i18n.t("details.ex_runBusy"));
    return;
  }
  publishRun({ mushafId, total: pages.length, done: 0, failed: [], stopping: false });
  window.addEventListener("beforeunload", askBeforeUnload);
  showProgress(current!);

  let lastError: string | null = null;
  let failuresInARow = 0;
  try {
    for (const pageNumber of pages) {
      if (current!.stopping) break;
      let failed = false;
      try {
        await exportLines(mushafId, pageNumber);
        failuresInARow = 0;
        // The page's PNG paths changed: a Finalize view of it reloads them.
        queryClient.invalidateQueries({ queryKey: queryKeys.page(mushafId, pageNumber) });
      } catch (e) {
        failed = true;
        failuresInARow += 1;
        lastError = e instanceof ApiError ? e.message : i18n.t("details.ex_exportFailed");
      }
      const run = current!;
      publishRun({
        ...run,
        done: run.done + 1,
        failed: failed ? [...run.failed, pageNumber] : run.failed,
      });
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW) break;
      showProgress(current!);
      if (current!.done % REFRESH_COUNTS_EVERY === 0) refreshExportCounts(queryClient, mushafId);
    }
  } finally {
    window.removeEventListener("beforeunload", askBeforeUnload);
    showOutcome(current!, lastError, failuresInARow >= MAX_FAILURES_IN_A_ROW);
    refreshExportCounts(queryClient, mushafId);
    publishRun(null);
  }
}

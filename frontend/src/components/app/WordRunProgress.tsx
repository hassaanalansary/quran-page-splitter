import { useTranslation } from "react-i18next";

import type { ProcessJob } from "@/lib/api";

/**
 * Progress for a word run, which counts **lines**.
 *
 * Its own component rather than the processing footer's, because a word run
 * leaves `pages_saved` at zero for the whole of it — the two runs share a table
 * but not a unit. Shared between the run page and the cuts page: the run is
 * started on one and can perfectly well finish while you are correcting a page on
 * the other, and both want to say how far along it is.
 */
export function WordRunProgress({ job }: { job: ProcessJob }) {
  const { t } = useTranslation();
  const pct = job.total > 0 ? Math.round((job.lines_done / job.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px] text-text-secondary">
        <span>{t("words.progress", { done: job.lines_done, total: job.total })}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-surface">
        <div
          className="h-full rounded-full bg-orange transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

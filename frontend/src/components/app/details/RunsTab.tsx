import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import type { Run } from "@/lib/api";
import { AbortDiagnostics } from "@/components/app/AbortDiagnostics";

import {
  fmtDayTime,
  RUN_STATUS_META,
  runAbortPage,
  runNumberLabel,
  runSettingsRows,
  runStatusKey,
} from "./helpers";

export function RunsTab({ mushafId, runs }: { mushafId: string; runs: Run[] | undefined }) {
  const { t } = useTranslation();
  if (!runs || runs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[11px] border border-border bg-white px-6 py-14 text-center">
        <span className="text-[13px] font-semibold text-text-primary">
          {t("details.runs_none")}
        </span>
        <span className="max-w-[380px] text-[11.5px] leading-[1.6] text-text-secondary">
          {t("details.runs_noneDesc")}
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="mt-1 rounded-lg bg-orange px-4 py-2 text-[12px] font-bold text-white transition-colors hover:bg-orange-hover"
        >
          {t("details.runs_new")}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11.5px] font-bold text-text-primary">
          {t("details.runs_count", { count: runs.length })}
        </span>
        <span className="text-[11.5px] text-text-muted">
          {t("details.runs_latest", { time: fmtDayTime(runs[0].created_at) })}
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="ms-auto rounded-[7px] bg-orange px-3 py-[5px] text-[10.5px] font-bold text-white transition-colors hover:bg-orange-hover"
        >
          {t("details.runs_new")}
        </Link>
      </div>
      <div className="flex flex-col gap-3">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} mushafId={mushafId} />
        ))}
      </div>
    </div>
  );
}

function RunCard({ run, mushafId }: { run: Run; mushafId: string }) {
  const { t } = useTranslation();
  const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.error;
  const statusLabel = t(runStatusKey(run.status));
  const abortPage = runAbortPage(run);
  const rangeSize = run.page_range_end - run.page_range_start + 1;
  // How far it got = what it actually persisted. Works for every status: a run
  // that stopped (aborted, cancelled, still running) saved exactly the pages
  // before the one it stopped on, so this never claims a full bar for a partial run.
  const pct = rangeSize > 0 ? Math.round((run.pages_saved / rangeSize) * 100) : 0;
  const aborted = run.status === "aborted_line_detection";
  const expected = run.abort_info?.["expected_lines"];
  const detected = run.abort_info?.["detected_lines"];
  const settingRows = runSettingsRows(run);

  return (
    <div className="overflow-hidden rounded-[11px] border border-border bg-white">
      <div className="flex items-center gap-[11px] border-b border-border px-3.5 py-3">
        <span className="font-mono text-[13px] font-bold text-text-primary">
          {runNumberLabel(run.run_number)}
        </span>
        <span className="text-[12px] font-medium text-text-secondary">
          {t("details.runs_pages", { start: run.page_range_start, end: run.page_range_end })}
        </span>
        <span
          className={`inline-flex items-center gap-[5px] rounded-pill px-2 py-0.5 text-[10.5px] font-semibold ${meta.bg} ${meta.text}`}
        >
          <span className="h-[5px] w-[5px] rounded-full" style={{ background: meta.dot }} />
          {statusLabel}
        </span>
        <span className="ms-auto text-[11px] font-medium text-text-muted">
          {fmtDayTime(run.created_at)} ·{" "}
          <b className="text-text-secondary">
            {t("details.runs_saved", { count: run.pages_saved })}
          </b>
        </span>
      </div>

      <div className="p-3.5">
        <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-muted">
          {t("details.runs_settings")}
        </div>
        <div className="grid grid-cols-2 gap-x-6">
          {settingRows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-2 border-b border-bg-surface py-1"
            >
              <span className="font-mono text-[11px] font-medium text-text-secondary">
                {row.label}
              </span>
              <span className="truncate font-mono text-[11px] font-bold text-text-primary">
                {row.value}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-3.5">
          {aborted ? (
            <>
              <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                {t("details.runs_outcome")}
              </div>
              <div className="mb-[9px] flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-bg-muted">
                  <div className="h-full bg-warning" style={{ width: `${pct}%` }} />
                </div>
                <span className="whitespace-nowrap font-mono text-[10.5px] font-semibold text-text-muted">
                  {t("details.runs_reached", { page: abortPage ?? "?", end: run.page_range_end })}
                </span>
              </div>
              <div className="text-[11.5px] leading-[1.6] text-text-secondary">
                {expected != null && detected != null
                  ? t("details.runs_mismatchDetail", {
                      expected: String(expected),
                      detected: String(detected),
                    })
                  : t("details.runs_mismatch")}{" "}
                {abortPage
                  ? t("details.runs_committedSkipped", {
                      cstart: run.page_range_start,
                      cend: run.page_range_start + run.pages_saved - 1,
                      sstart: abortPage,
                      send: run.page_range_end,
                    })
                  : t("details.runs_committed", {
                      start: run.page_range_start,
                      end: run.page_range_start + run.pages_saved - 1,
                    })}
              </div>
              {run.abort_info && (
                <div className="mt-2.5">
                  <AbortDiagnostics info={run.abort_info} logUrl={run.log_url} />
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3.5">
              <div className="flex flex-1 items-center gap-2">
                <div className="h-1.5 max-w-[180px] flex-1 overflow-hidden rounded-[3px] bg-bg-muted">
                  <div className="h-full" style={{ width: `${pct}%`, background: meta.dot }} />
                </div>
                <span className="font-mono text-[10.5px] font-semibold text-text-muted">
                  {t("details.runs_progress", { saved: run.pages_saved, total: rangeSize })}
                </span>
              </div>
              <span className="text-[11.5px] text-text-secondary">
                {run.status === "completed"
                  ? t("details.runs_completedMsg")
                  : run.status === "cancelled"
                    ? t("details.runs_cancelledMsg")
                    : run.status === "running"
                      ? t("details.runs_runningMsg")
                      : t("details.runs_failedMsg")}
              </span>
            </div>
          )}
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-bg-surface pt-3">
          <Link
            to="/mushafs/$mushafId/process"
            params={{ mushafId }}
            search={{ run: run.id }}
            className="text-[11px] font-bold text-orange hover:text-orange-hover"
          >
            {t("details.runs_rerun")}
          </Link>
          {aborted && (
            <Link
              to="/mushafs/$mushafId/process"
              params={{ mushafId }}
              search={{ run: run.id, from: abortPage ?? undefined }}
              className="text-[11px] font-bold text-text-secondary hover:text-text-primary"
            >
              {abortPage
                ? t("details.runs_resumeFrom", { page: abortPage })
                : t("details.runs_resume")}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

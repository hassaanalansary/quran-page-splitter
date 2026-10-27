import { Link } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Run } from "@/lib/api";
import { AbortDiagnostics } from "@/components/app/AbortDiagnostics";
import { RunLogDialog } from "@/components/app/RunLogDialog";

import {
  fmtDayTime,
  RUN_STATUS_META,
  runAbortPage,
  runNumberLabel,
  runSettingsRows,
  runStatusKey,
} from "./helpers";

/** How many of the latest runs open expanded; older ones fold to a row. */
const OPEN_RUNS = 2;

export function RunsTab({ mushafId, runs }: { mushafId: string; runs: Run[] | undefined }) {
  const { t } = useTranslation();
  if (!runs || runs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-panel border border-rule bg-card px-6 py-14 text-center">
        <span className="font-display text-[20px] font-semibold">{t("details.runs_none")}</span>
        <span className="max-w-[420px] text-[13.5px] leading-normal text-ink-2">
          {t("details.runs_noneDesc")}
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="mt-1 inline-flex h-10 items-center rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis no-underline hover:bg-lapis/90"
        >
          {t("details.runs_new")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 font-display text-[24px] font-semibold">{t("hub.runsTitle")}</h2>
          <span className="text-[13px] text-ink-3">
            {t("details.runs_count", { count: runs.length })}{" "}
            {t("details.runs_latest", { time: fmtDayTime(runs[0].created_at) })}
          </span>
        </div>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="inline-flex h-10 items-center rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis no-underline hover:bg-lapis/90"
        >
          {t("details.runs_new")}
        </Link>
      </div>
      <div className="flex flex-col gap-3">
        {runs.map((run, i) => (
          <RunCard key={run.id} run={run} mushafId={mushafId} defaultOpen={i < OPEN_RUNS} />
        ))}
      </div>
    </div>
  );
}

function RunCard({
  run,
  mushafId,
  defaultOpen,
}: {
  run: Run;
  mushafId: string;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [logOpen, setLogOpen] = useState(false);
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

  const summary = (
    <>
      <span className="font-mono text-[14px] font-semibold">{runNumberLabel(run.run_number)}</span>
      <span
        className={`inline-flex items-center gap-1.5 rounded-pill px-[9px] py-[3px] text-[12px] font-semibold ${meta.bg} ${meta.text}`}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} />
        {statusLabel}
      </span>
      <span className="text-[13px] text-ink-2">
        {t("details.runs_pages", { start: run.page_range_start, end: run.page_range_end })}
      </span>
      <span className="flex items-center gap-2">
        <span className="h-[5px] w-24 rounded-[3px] bg-sunk">
          <span
            className="block h-[5px] rounded-[3px]"
            style={{ width: `${pct}%`, background: aborted ? "var(--warn)" : meta.dot }}
          />
        </span>
        <span className="text-[12.5px] text-ink-3">
          {t("details.runs_saved", { count: run.pages_saved })}
        </span>
      </span>
      <span className="ms-auto text-[12.5px] text-ink-4">{fmtDayTime(run.created_at)}</span>
    </>
  );

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="flex w-full cursor-pointer flex-wrap items-center gap-x-3.5 gap-y-2 rounded-card border border-rule bg-card px-[18px] py-3 text-start transition-colors hover:border-rule-2"
      >
        {summary}
      </button>
    );
  }

  return (
    <article className="overflow-hidden rounded-panel border border-rule bg-card">
      <button
        type="button"
        aria-expanded={true}
        onClick={() => setOpen(false)}
        className="flex w-full cursor-pointer flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-rule-soft px-[18px] py-3.5 text-start"
      >
        {summary}
      </button>

      {run.log_url && (
        <RunLogDialog
          open={logOpen}
          onOpenChange={setLogOpen}
          mushafId={mushafId}
          runId={run.id}
          runNumber={run.run_number}
          live={false}
        />
      )}

      <div className="flex flex-wrap gap-5 p-[18px]">
        <dl className="m-0 grid flex-[1_1_360px] grid-cols-2 gap-x-6">
          {settingRows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-2 border-b border-rule-soft py-1.5"
            >
              <dt className="font-mono text-[12px] text-ink-3">{row.label}</dt>
              <dd className="m-0 truncate font-mono text-[12px] font-semibold">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-[1_1_280px] flex-col gap-2.5 rounded-card bg-sheet p-4">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            {t("details.runs_outcome")}
          </span>
          {aborted ? (
            <>
              <span className="font-mono text-[12px] text-ink-3">
                {t("details.runs_reached", { page: abortPage ?? "?", end: run.page_range_end })}
              </span>
              <p className="m-0 text-[13.5px] leading-normal text-ink-2">
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
              </p>
              {run.abort_info && <AbortDiagnostics info={run.abort_info} logUrl={run.log_url} />}
            </>
          ) : (
            <p className="m-0 text-[13.5px] leading-normal text-ink-2">
              {t("details.runs_progress", { saved: run.pages_saved, total: rangeSize })} ·{" "}
              {run.status === "completed"
                ? t("details.runs_completedMsg")
                : run.status === "cancelled"
                  ? t("details.runs_cancelledMsg")
                  : run.status === "running"
                    ? t("details.runs_runningMsg")
                    : t("details.runs_failedMsg")}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              to="/mushafs/$mushafId/process"
              params={{ mushafId }}
              search={{ run: run.id }}
              className="inline-flex h-9 items-center rounded-control bg-lapis px-3.5 text-[13px] font-semibold text-on-lapis no-underline hover:bg-lapis/90"
            >
              {t("details.runs_rerun")}
            </Link>
            {aborted && (
              <Link
                to="/mushafs/$mushafId/process"
                params={{ mushafId }}
                search={{ run: run.id, from: abortPage ?? undefined }}
                className="text-[13px] font-semibold text-ink-2 no-underline hover:text-ink"
              >
                {abortPage
                  ? t("details.runs_resumeFrom", { page: abortPage })
                  : t("details.runs_resume")}
              </Link>
            )}
            {run.log_url && (
              <button
                type="button"
                onClick={() => setLogOpen(true)}
                className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-semibold text-lapis-text hover:text-lapis-text/80"
              >
                <ScrollText size={14} aria-hidden="true" />
                {t("process.logView")}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

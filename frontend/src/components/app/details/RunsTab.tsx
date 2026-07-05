import { Link } from "@tanstack/react-router";

import type { Run } from "@/lib/api";

import {
  fmtDayTime,
  RUN_STATUS_META,
  runAbortPage,
  runNumberLabel,
  runSettingsRows,
} from "./helpers";

export function RunsTab({ mushafId, runs }: { mushafId: string; runs: Run[] | undefined }) {
  if (!runs || runs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[11px] border border-border bg-white px-6 py-14 text-center">
        <span className="text-[13px] font-semibold text-text-primary">No processing runs yet</span>
        <span className="max-w-[380px] text-[11.5px] leading-[1.6] text-text-secondary">
          Every run of the detection pipeline is recorded here with its settings and outcome.
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="mt-1 rounded-lg bg-orange px-4 py-2 text-[12px] font-bold text-white transition-colors hover:bg-orange-hover"
        >
          + New run
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11.5px] font-bold text-text-primary">
          {runs.length} processing run{runs.length === 1 ? "" : "s"}
        </span>
        <span className="text-[11.5px] text-text-muted">
          · latest {fmtDayTime(runs[0].created_at)}
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="ml-auto rounded-[7px] bg-orange px-3 py-[5px] text-[10.5px] font-bold text-white transition-colors hover:bg-orange-hover"
        >
          + New run
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
  const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.error;
  const abortPage = runAbortPage(run);
  const rangeSize = run.page_range_end - run.page_range_start + 1;
  const reached = abortPage ? abortPage - run.page_range_start : rangeSize;
  const pct = rangeSize > 0 ? Math.round((reached / rangeSize) * 100) : 0;
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
          pages {run.page_range_start}–{run.page_range_end}
        </span>
        <span
          className={`inline-flex items-center gap-[5px] rounded-pill px-2 py-0.5 text-[10.5px] font-semibold ${meta.bg} ${meta.text}`}
        >
          <span className="h-[5px] w-[5px] rounded-full" style={{ background: meta.dot }} />
          {meta.label}
        </span>
        <span className="ml-auto text-[11px] font-medium text-text-muted">
          {fmtDayTime(run.created_at)} ·{" "}
          <b className="text-text-secondary">{run.pages_saved} saved</b>
        </span>
      </div>

      <div className="p-3.5">
        <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-muted">
          Settings
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
                Outcome
              </div>
              <div className="mb-[9px] flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-bg-muted">
                  <div className="h-full bg-warning" style={{ width: `${pct}%` }} />
                </div>
                <span className="whitespace-nowrap font-mono text-[10.5px] font-semibold text-text-muted">
                  reached p.{abortPage ?? "?"} / {run.page_range_end}
                </span>
              </div>
              <div className="text-[11.5px] leading-[1.6] text-text-secondary">
                Line-count mismatch
                {expected != null && detected != null ? (
                  <>
                    : template expects <b className="text-text-primary">{String(expected)}</b>,
                    detector found <b className="text-text-primary">{String(detected)}</b>.
                  </>
                ) : (
                  "."
                )}{" "}
                Pages {run.page_range_start}–{run.page_range_start + run.pages_saved - 1} committed
                {abortPage ? `; ${abortPage}–${run.page_range_end} skipped.` : "."}
              </div>
              <div className="mt-2.5 rounded-[7px] border border-border bg-bg-surface px-2.5 py-2 font-mono text-[10.5px] font-medium text-text-muted">
                abort_info = {JSON.stringify(run.abort_info)}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3.5">
              <div className="flex flex-1 items-center gap-2">
                <div className="h-1.5 max-w-[180px] flex-1 overflow-hidden rounded-[3px] bg-bg-muted">
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: run.status === "completed" ? "var(--success)" : "var(--error)",
                    }}
                  />
                </div>
                <span className="font-mono text-[10.5px] font-semibold text-text-muted">
                  {run.pages_saved} / {rangeSize}
                </span>
              </div>
              <span className="text-[11.5px] text-text-secondary">
                {run.status === "completed"
                  ? "Completed — all pages in range persisted."
                  : "Run failed — check the settings and try again."}
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
            Re-run with these settings →
          </Link>
          {aborted && (
            <Link
              to="/mushafs/$mushafId/process"
              params={{ mushafId }}
              search={{ run: run.id, from: abortPage ?? undefined }}
              className="text-[11px] font-bold text-text-secondary hover:text-text-primary"
            >
              Resume{abortPage ? ` from p.${abortPage}` : ""} →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

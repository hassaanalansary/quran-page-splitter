import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CircleHelp, Minus, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Hint } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ApiError,
  isJobRunning,
  planCalibrationBatch,
  startCalibrationBatch,
  useCalibrationReadiness,
  type BatchRange,
  type BatchReason,
  type CalibrationBatchReport,
  type ProcessJob,
} from "@/lib/api";
import type {
  BatchPlan,
  CalibrationReadiness,
  ReadinessCheck,
  ReadinessState,
} from "@/lib/calibration/types";

/** Reasons a batch leaves a page alone, in the order the plan lists them. */
const LEFT_ALONE = [
  "confirmed",
  "edited",
  "untouched",
  "current",
  "not_reviewed",
  "not_numbered",
  "missing",
] as const satisfies readonly BatchReason[];
/** Ranges of page numbers listed before the rest are summed up. */
const LISTED_RANGES = 8;

/**
 * Bulk processing for calibration: the readiness meter, and *Process pages N–M*.
 *
 * **The meter** says how sure the confirmed pages make us that processing the rest
 * of the mushaf now would lose nothing — see backend/api/services/calibration_progress.py
 * for its four checks. It moves with every confirmation, which is the point: it is
 * how the reviewer sees the page-by-page work paying off.
 *
 * **A batch** processes a range of pages in one background job, the same job table
 * and the same one-run-at-a-time rule as processing one page. Confirmed pages and
 * drafts someone worked on are never processed over. While it runs, its progress
 * takes the meter's place, and every page it finishes can be opened and reviewed.
 */
export function BulkPanel({
  mushafId,
  page,
  pageCount,
  job,
  onStarted,
  onStop,
  stopping,
}: {
  mushafId: string;
  page: number;
  pageCount: number;
  /** The mushaf's latest calibration job, of either kind. */
  job: ProcessJob | null;
  onStarted: (job: ProcessJob) => void;
  onStop: () => void;
  stopping: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data: readiness } = useCalibrationReadiness(mushafId);
  const batch = job?.kind === "calibration_batch" ? job : null;
  const running = isJobRunning(batch);
  const busy = isJobRunning(job);

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-border bg-white p-3">
      {running && batch ? (
        <BatchProgress
          job={batch}
          fallbackSeconds={readiness?.cost.process_seconds ?? null}
          onStop={onStop}
          stopping={stopping || batch.cancel_requested}
        />
      ) : (
        <MeterSummary readiness={readiness} />
      )}
      {!running && batch?.report && <LastBatch job={batch} report={batch.report} />}
      <Button variant="outline" className="h-8 text-[12px]" onClick={() => setOpen(true)}>
        {t("calibration.bulk.open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("calibration.bulk.title")}</DialogTitle>
            <DialogDescription>{t("calibration.bulk.intro")}</DialogDescription>
          </DialogHeader>
          <ReadinessDetails readiness={readiness} />
          {/* Inside the content, so it unmounts on close: every opening starts from
              the suggested range, and asks the server again what it would do. */}
          <BatchForm
            mushafId={mushafId}
            page={page}
            pageCount={pageCount}
            readiness={readiness}
            busy={busy}
            onCancel={() => setOpen(false)}
            onStarted={(started) => {
              setOpen(false);
              onStarted(started);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── the meter ────────────────────────────────────────────────────────────────

function MeterSummary({ readiness }: { readiness: CalibrationReadiness | undefined }) {
  const { t } = useTranslation();
  const pages = readiness?.checks.find((check) => check.key === "pages");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-text-primary">
          {t("calibration.bulk.meterTitle")}
        </span>
        <span className="text-[14px] font-bold text-text-primary">
          {readiness ? `${readiness.score}%` : "…"}
        </span>
      </div>
      <Meter score={readiness?.score ?? 0} level={readiness?.level ?? "keep"} />
      {readiness && (
        <span className="text-[11px] leading-snug text-text-secondary">
          {t(`calibration.bulk.level.${readiness.level}`)}
          {pages?.key === "pages" &&
            ` · ${t("calibration.bulk.pagesShort", { count: pages.values.count, target: pages.values.target })}`}
        </span>
      )}
    </div>
  );
}

/** A ratio against its limit: the fill carries the level, the track is a lighter step
 * of the same colour. Ready is the only level drawn green. */
function Meter({ score, level, tall }: { score: number; level: string; tall?: boolean }) {
  const ready = level === "ready";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
      className={`w-full overflow-hidden rounded-full ${tall ? "h-2.5" : "h-1.5"} ${
        ready ? "bg-success-bg" : "bg-orange-glow"
      }`}
    >
      <div
        className={`h-full rounded-full transition-all ${ready ? "bg-success" : "bg-orange"}`}
        style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
      />
    </div>
  );
}

function ReadinessDetails({ readiness }: { readiness: CalibrationReadiness | undefined }) {
  const { t } = useTranslation();
  const duration = useDuration();
  if (!readiness) {
    return <p className="text-[12px] text-text-muted">{t("calibration.bulk.loading")}</p>;
  }
  const { process_seconds: process, review_minutes: review } = readiness.cost;
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-bg-surface p-3.5">
      <div className="flex items-end gap-3">
        <span className="text-[36px] font-extrabold leading-none text-navy">
          {readiness.score}%
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-1">
          <span className="text-[13px] font-semibold text-text-primary">
            {t(`calibration.bulk.level.${readiness.level}`)}
          </span>
          <Meter score={readiness.score} level={readiness.level} tall />
        </div>
      </div>
      <p className="text-[11.5px] leading-snug text-text-secondary">
        {t("calibration.bulk.meterIntro")}
      </p>
      <ul className="flex flex-col gap-2">
        {readiness.checks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ul>
      <LearningChart pages={readiness.pages} />
      <p className="text-[11px] leading-snug text-text-muted">
        {process !== null && review !== null
          ? t("calibration.bulk.cost", { process: duration(process), review })
          : process !== null
            ? t("calibration.bulk.costProcess", { process: duration(process) })
            : t("calibration.bulk.costUnknown")}
      </p>
      <p className="text-[11px] leading-snug text-text-muted">{t("calibration.bulk.meterBlind")}</p>
    </section>
  );
}

const STATE_ICON: Record<ReadinessState, ReactNode> = {
  pass: <Check size={13} />,
  near: <Minus size={13} />,
  fail: <X size={13} />,
  unknown: <CircleHelp size={13} />,
};

const STATE_STYLE: Record<ReadinessState, string> = {
  pass: "bg-success-bg text-success",
  near: "bg-warning-bg text-[#8a4b0d]",
  fail: "bg-error-bg text-error",
  unknown: "bg-bg-muted text-text-secondary",
};

function CheckRow({ check }: { check: ReadinessCheck }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-px flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full ${STATE_STYLE[check.state]}`}
        role="img"
        aria-label={t(`calibration.bulk.state.${check.state}`)}
        title={t(`calibration.bulk.state.${check.state}`)}
      >
        {STATE_ICON[check.state]}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12px] font-semibold text-text-primary">
          {t(`calibration.bulk.checkTitle.${check.key}`)}
        </span>
        <span className="text-[11.5px] leading-snug text-text-secondary">
          <CheckSentence check={check} />
        </span>
      </span>
    </li>
  );
}

/** What one check found, said with its own numbers. */
function CheckSentence({ check }: { check: ReadinessCheck }) {
  const { t } = useTranslation();
  switch (check.key) {
    case "pages": {
      const { count, target } = check.values;
      return check.state === "pass"
        ? t("calibration.bulk.check.pagesEnough", { count, target })
        : t("calibration.bulk.check.pagesMore", { count, target });
    }
    case "trust": {
      const { made, wrong, pages } = check.values;
      if (check.state === "unknown") return t("calibration.bulk.check.trustUnknown");
      return wrong
        ? t("calibration.bulk.check.trustWrong", { made, wrong, pages })
        : t("calibration.bulk.check.trustRight", { made, pages });
    }
    case "settled": {
      const { growth, latest, pages } = check.values;
      if (check.state === "unknown" || growth === null)
        return t("calibration.bulk.check.settledUnknown");
      const shown = growth.toFixed(1);
      return check.state === "pass"
        ? t("calibration.bulk.check.settledFlat", { growth: shown, latest, pages })
        : t("calibration.bulk.check.settledGrowing", { growth: shown, latest, pages });
    }
    case "fixes": {
      const { rate, pages, words_per_page: words } = check.values;
      if (check.state === "unknown" || rate === null)
        return t("calibration.bulk.check.fixesUnknown");
      const fixes = t("calibration.bulk.check.fixes", {
        perPage: check.values.per_page,
        rate,
        pages,
      });
      return words !== null
        ? `${fixes} ${t("calibration.bulk.check.fixesWords", { words })}`
        : fixes;
    }
  }
}

/** Durations for a person: seconds, minutes, or hours and minutes. */
function useDuration() {
  const { t } = useTranslation();
  return (seconds: number): string => {
    const whole = Math.max(0, Math.round(seconds));
    if (whole < 60) return t("calibration.bulk.duration.seconds", { count: whole });
    const minutes = Math.round(whole / 60);
    if (minutes < 60) return t("calibration.bulk.duration.minutes", { count: minutes });
    return t("calibration.bulk.duration.hours", {
      hours: Math.floor(minutes / 60),
      minutes: minutes % 60,
    });
  };
}

// ── the chart ────────────────────────────────────────────────────────────────

/**
 * The share of each confirmed page's blobs the learning proposed a role for — the
 * settled check's evidence. One series, so one colour and no legend: the caption
 * names it. The latest value is labelled; every bar answers hover and focus; the
 * table under it holds every number without hovering.
 */
function LearningChart({ pages }: { pages: CalibrationReadiness["pages"] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);
  if (!pages.length) {
    return <p className="text-[11.5px] text-text-muted">{t("calibration.bulk.chartEmpty")}</p>;
  }
  const last = pages[pages.length - 1];
  const shown = active !== null ? pages[active] : null;
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-[11.5px] font-semibold text-text-secondary">
        {t("calibration.bulk.chartTitle")}
      </figcaption>
      {/* Page order runs left to right, whichever way the interface reads. */}
      <div dir="ltr" className="relative flex gap-1.5">
        <div className="flex h-[88px] w-8 flex-none flex-col justify-between text-end text-[10px] tabular-nums text-text-muted">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div className="relative h-[88px] flex-1">
          {[0, 50, 100].map((at) => (
            <div
              key={at}
              className="absolute inset-x-0 h-px bg-border"
              style={{ bottom: `${at}%` }}
              aria-hidden
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {pages.map((entry, index) => (
              <div
                key={entry.page}
                tabIndex={0}
                role="img"
                aria-label={t("calibration.bulk.barLabel", {
                  page: entry.page,
                  value: entry.coverage,
                })}
                onPointerEnter={() => setActive(index)}
                onPointerLeave={() => setActive((current) => (current === index ? null : current))}
                onFocus={() => setActive(index)}
                onBlur={() => setActive((current) => (current === index ? null : current))}
                className="relative flex h-full max-w-[24px] flex-1 cursor-default items-end outline-none"
              >
                <div
                  className={`w-full rounded-t-[4px] bg-navy-light transition-opacity ${
                    active !== null && active !== index ? "opacity-50" : ""
                  }`}
                  style={{ height: `${Math.max(entry.coverage, 0.5)}%` }}
                />
              </div>
            ))}
          </div>
          {shown && active !== null ? (
            <div
              className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-white px-2 py-1 shadow-md"
              style={{ left: `${((active + 0.5) / pages.length) * 100}%` }}
            >
              <div className="text-[12px] font-bold text-text-primary">{shown.coverage}%</div>
              <div className="text-[10.5px] text-text-secondary">
                {t("calibration.bulk.tooltipPage", { page: shown.page })}
              </div>
              <div className="text-[10.5px] text-text-secondary">
                {shown.fixes !== null
                  ? t("calibration.bulk.tooltipFixes", { fixes: shown.fixes, words: shown.words })
                  : t("calibration.bulk.tooltipWords", { words: shown.words })}
              </div>
            </div>
          ) : (
            <span
              className="pointer-events-none absolute -translate-x-1/2 text-[10px] font-semibold text-text-secondary"
              style={{
                left: `${((pages.length - 0.5) / pages.length) * 100}%`,
                bottom: `calc(${last.coverage}% + 2px)`,
              }}
            >
              {last.coverage}%
            </span>
          )}
        </div>
      </div>
      <div
        dir="ltr"
        className="flex justify-between ps-[38px] text-[10px] tabular-nums text-text-muted"
      >
        <span>{t("calibration.bulk.axisPage", { page: pages[0].page })}</span>
        {pages.length > 1 && <span>{t("calibration.bulk.axisPage", { page: last.page })}</span>}
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-text-secondary">
          {t("calibration.bulk.tableToggle", { count: pages.length })}
        </summary>
        <table className="mt-1 w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-text-muted">
              {(["page", "decided", "wrong", "fixes", "words", "minutes"] as const).map(
                (column) => (
                  <th key={column} className="px-1 pb-1 text-end font-semibold first:text-start">
                    {t(`calibration.bulk.column.${column}`)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {pages.map((entry) => (
              <tr key={entry.page} className="border-t border-border">
                <td className="py-0.5">{entry.page}</td>
                <td className="px-1 py-0.5 text-end">{entry.coverage}%</td>
                <td className="px-1 py-0.5 text-end">{entry.learned_wrong}</td>
                <td className="px-1 py-0.5 text-end">{entry.fixes ?? "—"}</td>
                <td className="px-1 py-0.5 text-end">{`${entry.words}/${entry.words_total}`}</td>
                <td className="px-1 py-0.5 text-end">{entry.minutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

// ── the range ────────────────────────────────────────────────────────────────

function BatchForm({
  mushafId,
  page,
  pageCount,
  readiness,
  busy,
  onCancel,
  onStarted,
}: {
  mushafId: string;
  page: number;
  pageCount: number;
  readiness: CalibrationReadiness | undefined;
  busy: boolean;
  onCancel: () => void;
  onStarted: (job: ProcessJob) => void;
}) {
  const { t } = useTranslation();
  // From the page after the last one confirmed: what came before it is reviewed.
  const confirmed = readiness?.pages ?? [];
  const suggested = confirmed.length ? confirmed[confirmed.length - 1].page + 1 : page;
  const [first, setFirst] = useState(() => String(Math.min(pageCount, Math.max(1, suggested))));
  const [last, setLast] = useState(() => String(pageCount));
  const [refresh, setRefresh] = useState(false);
  const range = parseRange(first, last, pageCount);

  // Asked again shortly after the range stops changing, not on every keystroke.
  const [asked, setAsked] = useState<BatchRange | null>(null);
  const from = range?.first ?? null;
  const to = range?.last ?? null;
  useEffect(() => {
    const timer = window.setTimeout(
      () => setAsked(from !== null && to !== null ? { first: from, last: to, refresh } : null),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [from, to, refresh]);

  const plan = useQuery({
    queryKey: ["mushaf", mushafId, "calibration-plan", asked],
    queryFn: ({ signal }) => planCalibrationBatch(mushafId, asked!, signal),
    enabled: asked !== null,
    staleTime: 0,
  });

  const start = useMutation({
    mutationFn: () =>
      startCalibrationBatch(mushafId, { first: range!.first, last: range!.last, refresh }),
    onSuccess: ({ job }) => {
      toast.success(
        t("calibration.bulk.startedToast", {
          first: job.page_range_start,
          last: job.page_range_end,
        }),
      );
      onStarted(job);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t("calibration.requestFailed")),
  });

  // Only the plan for exactly what the form says now: a moment ago's would show the
  // counts of another range, or of the other answer to "process again".
  const current =
    plan.data &&
    asked &&
    range &&
    asked.first === range.first &&
    asked.last === range.last &&
    asked.refresh === refresh
      ? plan.data
      : null;
  const count = current ? current.process + current.untouched : 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-text-secondary">
          {t("calibration.bulk.from")}
          <input
            type="number"
            min={1}
            max={pageCount}
            value={first}
            onChange={(event) => setFirst(event.target.value)}
            className="h-9 w-24 rounded-md border-[1.5px] border-border-strong px-2.5 text-[13px] tabular-nums outline-none focus:border-orange"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-text-secondary">
          {t("calibration.bulk.to")}
          <input
            type="number"
            min={1}
            max={pageCount}
            value={last}
            onChange={(event) => setLast(event.target.value)}
            className="h-9 w-24 rounded-md border-[1.5px] border-border-strong px-2.5 text-[13px] tabular-nums outline-none focus:border-orange"
          />
        </label>
        <span className="pb-2 text-[11px] text-text-muted">
          {t("calibration.bulk.ofPages", { count: pageCount })}
        </span>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-snug text-text-primary">
        <Checkbox
          checked={refresh}
          onCheckedChange={(value) => setRefresh(value === true)}
          className="mt-0.5"
        />
        <span>
          {t("calibration.bulk.refresh")}
          <span className="block text-[11px] text-text-muted">
            {t("calibration.bulk.refreshHelp")}
          </span>
        </span>
      </label>

      {!range ? (
        <Hint tone="warning">{t("calibration.bulk.badRange", { count: pageCount })}</Hint>
      ) : plan.isError ? (
        <Hint tone="warning">
          {plan.error instanceof ApiError ? plan.error.message : t("calibration.requestFailed")}
        </Hint>
      ) : !current ? (
        <p className="text-[12px] text-text-muted">{t("calibration.bulk.planLoading")}</p>
      ) : (
        <PlanSummary plan={current} readiness={readiness} />
      )}

      {busy && <Hint tone="warning">{t("calibration.bulk.running")}</Hint>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={start.isPending}>
          {t("calibration.bulk.cancel")}
        </Button>
        <Button
          onClick={() => start.mutate()}
          disabled={!current || count === 0 || busy || start.isPending || plan.isFetching}
        >
          {start.isPending
            ? t("calibration.bulk.starting")
            : current && current.process === 0 && current.untouched > 0
              ? t("calibration.bulk.startChanged")
              : t("calibration.bulk.start", { count: current?.process ?? 0 })}
        </Button>
      </div>
    </section>
  );
}

function parseRange(first: string, last: string, pageCount: number) {
  const from = Number(first);
  const to = Number(last);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1 || to > pageCount || from > to) return null;
  return { first: from, last: to };
}

function PlanSummary({
  plan,
  readiness,
}: {
  plan: BatchPlan;
  readiness: CalibrationReadiness | undefined;
}) {
  const { t } = useTranslation();
  const duration = useDuration();
  const alone = LEFT_ALONE.filter((reason) => plan.pages[reason]?.length);
  const pages = plan.process + plan.untouched;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-[12px] leading-snug">
      <span className="font-semibold text-text-primary">
        {t("calibration.bulk.planProcess", { count: plan.process })}
      </span>
      {alone.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary">{t("calibration.bulk.leftAlone")}</span>
          <ul className="flex flex-col gap-0.5 ps-3 text-[11.5px] text-text-secondary">
            {alone.map((reason) => (
              <li key={reason}>
                {t(`calibration.bulk.reason.${reason}`, { count: plan.pages[reason]!.length })}
                <span className="ms-1.5 font-mono text-[10.5px] text-text-muted" dir="ltr">
                  {ranges(plan.pages[reason]!)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pages > 0 && (
        <span className="text-[11.5px] text-text-secondary">
          {plan.process_seconds !== null
            ? t("calibration.bulk.estimate", {
                time: duration(plan.process * plan.process_seconds),
                seconds: plan.process_seconds,
              })
            : t("calibration.bulk.estimateUnknown")}
        </span>
      )}
      {!plan.experimental && pages > 0 && (
        <Hint tone="warning">{t("calibration.bulk.learningOff")}</Hint>
      )}
      {readiness && readiness.level !== "ready" && pages > 0 && (
        <Hint>{t("calibration.bulk.notReady")}</Hint>
      )}
    </div>
  );
}

/** Page numbers as runs — "12–15, 20, 31–40" — the first few, then how many more. */
function ranges(pages: number[]): string {
  const runs: string[] = [];
  let start = pages[0];
  let previous = pages[0];
  for (const page of [...pages.slice(1), Number.NaN]) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    runs.push(start === previous ? String(start) : `${start}–${previous}`);
    start = page;
    previous = page;
  }
  return runs.length > LISTED_RANGES
    ? `${runs.slice(0, LISTED_RANGES).join(", ")}, … (+${runs.length - LISTED_RANGES})`
    : runs.join(", ");
}

// ── a batch running, and the last one ────────────────────────────────────────

function counts(report: CalibrationBatchReport | null | undefined) {
  const processed = report?.processed.length ?? 0;
  const failed = report?.failed.length ?? 0;
  const skipped = Object.values(report?.skipped ?? {}).reduce(
    (total, pages) => total + (pages?.length ?? 0),
    0,
  );
  return { processed, failed, skipped };
}

function BatchProgress({
  job,
  fallbackSeconds,
  onStop,
  stopping,
}: {
  job: ProcessJob;
  /** What a page took lately, before this batch has timed one of its own. */
  fallbackSeconds: number | null;
  onStop: () => void;
  stopping: boolean;
}) {
  const { t } = useTranslation();
  const duration = useDuration();
  const report = job.report;
  const { processed, failed, skipped } = counts(report);
  const visited = processed + failed + skipped;
  const pct = job.total > 0 ? Math.round((visited / job.total) * 100) : 0;
  const perPage =
    processed && report?.busy_seconds ? report.busy_seconds / processed : fallbackSeconds;
  const remaining = Math.max(0, (report?.planned ?? 0) - processed - failed);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-text-primary">
          {t("calibration.bulk.progressTitle", {
            first: job.page_range_start,
            last: job.page_range_end,
          })}
        </span>
        <span className="text-[12px] font-bold tabular-nums text-text-primary">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-orange-glow">
        <div
          className="h-full rounded-full bg-orange transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] leading-snug text-text-secondary">
        {t("calibration.bulk.progressLine", { page: job.current_page ?? "…", processed, skipped })}
        {failed > 0 && ` · ${t("calibration.bulk.progressFailed", { count: failed })}`}
      </span>
      {perPage !== null && remaining > 0 && (
        <span className="text-[11px] text-text-muted">
          {t("calibration.bulk.progressLeft", { time: duration(remaining * perPage) })}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={onStop} disabled={stopping}>
        {stopping ? t("calibration.bulk.stopping") : t("calibration.bulk.stop")}
      </Button>
    </div>
  );
}

function LastBatch({ job, report }: { job: ProcessJob; report: CalibrationBatchReport }) {
  const { t } = useTranslation();
  const { processed, failed, skipped } = counts(report);
  const state =
    job.state === "completed"
      ? ""
      : ` (${t(job.state === "cancelled" ? "calibration.bulk.lastStopped" : "calibration.bulk.lastBroken")})`;
  return (
    <div className="flex flex-col gap-0.5 rounded-sm bg-bg-surface px-2 py-1.5 text-[11px] leading-snug text-text-secondary">
      <span>
        {t("calibration.bulk.lastBatch", {
          first: report.first,
          last: report.last,
          processed,
          skipped,
          failed,
        })}
        {state}
      </span>
      {failed > 0 && (
        <span className="text-error" dir="auto">
          {t("calibration.bulk.failedPages", {
            pages: ranges(report.failed.map((entry) => entry.page)),
          })}
        </span>
      )}
    </div>
  );
}

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CircleHelp, Info, Minus, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  DIALOG_PRIMARY,
  DIALOG_SECONDARY,
  SatrDialogClose,
  SatrDialogFrame,
} from "@/components/app/SatrDialog";
import { BusyLabel } from "@/components/app/SatrLoader";
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
  "drafted",
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
 * and the same one-run-at-a-time rule as processing one page. Confirmed pages are
 * never processed over; a draft processed again keeps every decision on its blobs.
 * While it runs, its progress
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
    <div className="flex flex-col gap-2">
      {running && batch ? (
        <section className="flex flex-col gap-2.5 rounded-card border border-rule bg-card p-3.5">
          <BatchProgress
            job={batch}
            fallbackSeconds={readiness?.cost.process_seconds ?? null}
            onStop={onStop}
            stopping={stopping || batch.cancel_requested}
          />
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="cursor-pointer self-start text-[13px] font-semibold text-lapis-text hover:underline"
          >
            {t("calibration.bulk.open")}
          </button>
        </section>
      ) : (
        <MeterCard readiness={readiness} onOpen={() => setOpen(true)} />
      )}
      {!running && batch?.report && <LastBatch job={batch} report={batch.report} />}
      <SatrDialogFrame open={open} onOpenChange={setOpen} width={940}>
        <div className="flex flex-none items-start gap-4 bg-deep px-[26px] py-5 text-on-deep">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DialogPrimitive.Title className="m-0 font-display text-[26px] font-semibold leading-tight">
              {t("calibration.bulk.title")}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="m-0 max-w-[640px] text-[14px] leading-normal text-on-deep-2">
              {t("calibration.bulk.intro")}
            </DialogPrimitive.Description>
          </div>
          <SatrDialogClose className="bg-white/10 text-on-deep hover:bg-white/20 hover:text-on-deep" />
        </div>
        {/* Inside the content, so it unmounts on close: every opening starts from
            the suggested range, and asks the server again what it would do. */}
        <BatchForm
          mushafId={mushafId}
          page={page}
          pageCount={pageCount}
          readiness={readiness}
          busy={busy}
          lastBatch={
            !running && batch?.report ? <LastBatch job={batch} report={batch.report} /> : null
          }
          onCancel={() => setOpen(false)}
          onStarted={(started) => {
            setOpen(false);
            onStarted(started);
          }}
        >
          <ReadinessDetails readiness={readiness} />
        </BatchForm>
      </SatrDialogFrame>
    </div>
  );
}

// ── the meter ────────────────────────────────────────────────────────────────

/** The meter in the inspector, on deep lapis: the level, a segment per check (gold
 * when it passes), and the way into the bulk dialog. */
function MeterCard({
  readiness,
  onOpen,
}: {
  readiness: CalibrationReadiness | undefined;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const pages = readiness?.checks.find((check) => check.key === "pages");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex cursor-pointer flex-col gap-2 rounded-card bg-deep p-3.5 text-start text-on-deep transition-[filter] hover:brightness-110"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-on-deep-2">
          {t("calibration.bulk.meterTitle")}
        </span>
        <span className="font-mono text-[12px] text-on-deep-2">
          {pages?.key === "pages"
            ? `${pages.values.count} / ${pages.values.target}`
            : readiness
              ? `${readiness.score}%`
              : "…"}
        </span>
      </span>
      {readiness ? (
        <span className="font-display text-[18px] font-semibold leading-tight">
          {t(`calibration.bulk.level.${readiness.level}`)}
          <span className="ms-2 font-sans text-[13px] font-normal text-on-deep-2">
            {readiness.score}%
          </span>
        </span>
      ) : (
        <span className="text-[13px] text-on-deep-2">{t("calibration.bulk.loading")}</span>
      )}
      <span className="flex gap-1" aria-hidden="true">
        {(readiness?.checks ?? []).map((check) => (
          <span
            key={check.key}
            className={`h-[5px] flex-1 rounded-[3px] ${
              check.state === "pass"
                ? "bg-gold"
                : check.state === "near"
                  ? "bg-gold/50"
                  : "bg-white/20"
            }`}
          />
        ))}
      </span>
      <span className="flex items-center gap-1 text-[12.5px] text-on-deep-2">
        {t("calibration.bulk.open")}
        <ArrowRight size={13} className="rtl:rotate-180" aria-hidden="true" />
      </span>
    </button>
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
        ready ? "bg-done-wash" : "bg-lapis/15"
      }`}
    >
      <div
        className={`h-full rounded-full transition-all ${ready ? "bg-done" : "bg-lapis"}`}
        style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
      />
    </div>
  );
}

function ReadinessDetails({ readiness }: { readiness: CalibrationReadiness | undefined }) {
  const { t } = useTranslation();
  const duration = useDuration();
  if (!readiness) {
    return <p className="m-0 text-[13px] text-ink-3">{t("calibration.bulk.loading")}</p>;
  }
  const { process_seconds: process, review_minutes: review } = readiness.cost;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            {t("calibration.bulk.meterTitle")}
          </span>
          <span className="font-display text-[26px] font-semibold leading-tight text-gold-text">
            {t(`calibration.bulk.level.${readiness.level}`)}
            <span className="ms-2 font-sans text-[15px] font-semibold text-ink-2">
              {readiness.score}%
            </span>
          </span>
        </span>
        <span className="text-[12.5px] text-ink-3">{t("calibration.bulk.estimateNote")}</span>
      </div>
      <Meter score={readiness.score} level={readiness.level} tall />
      <p className="m-0 text-[12.5px] leading-normal text-ink-2">
        {t("calibration.bulk.meterIntro")}
      </p>
      <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2">
        {readiness.checks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded-card bg-sheet p-3.5">
        <LearningChart pages={readiness.pages} />
      </div>
      <p className="m-0 text-[12px] leading-snug text-ink-3">
        {process !== null && review !== null
          ? t("calibration.bulk.cost", { process: duration(process), review })
          : process !== null
            ? t("calibration.bulk.costProcess", { process: duration(process) })
            : t("calibration.bulk.costUnknown")}
      </p>
      <p className="m-0 text-[12px] leading-snug text-ink-3">{t("calibration.bulk.meterBlind")}</p>
    </>
  );
}

const STATE_ICON: Record<ReadinessState, ReactNode> = {
  pass: <Check size={11} strokeWidth={3} aria-hidden="true" />,
  near: <Minus size={11} strokeWidth={3} aria-hidden="true" />,
  fail: <X size={11} strokeWidth={3} aria-hidden="true" />,
  unknown: <CircleHelp size={11} aria-hidden="true" />,
};

/** A check's pill: the state's colour, solid. */
const STATE_STYLE: Record<ReadinessState, string> = {
  pass: "bg-done text-on-done",
  near: "bg-warn text-on-warn",
  fail: "bg-stop text-on-stop",
  unknown: "bg-sunk text-ink-2",
};

/** A check's card: a wash of the same colour. */
const STATE_CARD: Record<ReadinessState, string> = {
  pass: "bg-done-wash",
  near: "bg-warn-wash",
  fail: "bg-stop-wash",
  unknown: "bg-sheet",
};

function CheckRow({ check }: { check: ReadinessCheck }) {
  const { t } = useTranslation();
  return (
    <li className={`flex flex-col gap-1.5 rounded-card px-3.5 py-3 ${STATE_CARD[check.state]}`}>
      <span className="flex items-center justify-between gap-2">
        <strong className="text-[13.5px]">{t(`calibration.bulk.checkTitle.${check.key}`)}</strong>
        <span
          className={`inline-flex items-center gap-1 rounded-pill px-2 py-px text-[11.5px] font-bold ${STATE_STYLE[check.state]}`}
        >
          {STATE_ICON[check.state]}
          {t(`calibration.bulk.state.${check.state}`)}
        </span>
      </span>
      <span className="text-[12.5px] leading-[1.45] text-ink-2">
        <CheckSentence check={check} />
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
    return <p className="m-0 text-[12.5px] text-ink-3">{t("calibration.bulk.chartEmpty")}</p>;
  }
  const last = pages[pages.length - 1];
  const shown = active !== null ? pages[active] : null;
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-[13px] font-semibold text-ink">
        {t("calibration.bulk.chartTitle")}
      </figcaption>
      {/* Page order runs left to right, whichever way the interface reads. */}
      <div dir="ltr" className="relative flex gap-1.5">
        <div className="flex h-[88px] w-8 flex-none flex-col justify-between text-end text-[10px] tabular-nums text-ink-3">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div className="relative h-[88px] flex-1">
          {[0, 50, 100].map((at) => (
            <div
              key={at}
              className="absolute inset-x-0 h-px bg-rule"
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
                  className={`w-full rounded-t-[4px] bg-lapis transition-opacity ${
                    active !== null && active !== index ? "opacity-50" : ""
                  }`}
                  style={{ height: `${Math.max(entry.coverage, 0.5)}%` }}
                />
              </div>
            ))}
          </div>
          {shown && active !== null ? (
            <div
              className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-rule bg-card px-2 py-1 shadow-md"
              style={{ left: `${((active + 0.5) / pages.length) * 100}%` }}
            >
              <div className="text-[12px] font-bold text-ink">{shown.coverage}%</div>
              <div className="text-[10.5px] text-ink-2">
                {t("calibration.bulk.tooltipPage", { page: shown.page })}
              </div>
              <div className="text-[10.5px] text-ink-2">
                {shown.fixes !== null
                  ? t("calibration.bulk.tooltipFixes", { fixes: shown.fixes, words: shown.words })
                  : t("calibration.bulk.tooltipWords", { words: shown.words })}
              </div>
            </div>
          ) : (
            <span
              className="pointer-events-none absolute -translate-x-1/2 text-[10px] font-semibold text-ink-2"
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
      <div dir="ltr" className="flex justify-between ps-[38px] text-[10px] tabular-nums text-ink-3">
        <span>{t("calibration.bulk.axisPage", { page: pages[0].page })}</span>
        {pages.length > 1 && <span>{t("calibration.bulk.axisPage", { page: last.page })}</span>}
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-ink-2">
          {t("calibration.bulk.tableToggle", { count: pages.length })}
        </summary>
        <table className="mt-1 w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-ink-3">
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
              <tr key={entry.page} className="border-t border-rule">
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
  lastBatch,
  onCancel,
  onStarted,
  children,
}: {
  mushafId: string;
  page: number;
  pageCount: number;
  readiness: CalibrationReadiness | undefined;
  busy: boolean;
  /** The last batch's line, under the range. */
  lastBatch: ReactNode;
  onCancel: () => void;
  onStarted: (job: ProcessJob) => void;
  /** The first column: the readiness. */
  children: ReactNode;
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
  const count = current ? current.process + current.drafted : 0;

  const input =
    "h-10 w-full min-w-0 rounded-control border border-rule-2 bg-card px-2.5 font-mono text-[14px] font-medium text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)]";

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-wrap gap-x-7 gap-y-[22px] overflow-y-auto px-[26px] py-5">
        <section className="flex min-w-0 flex-[3_1_440px] flex-col gap-3.5">{children}</section>

        <section className="flex min-w-0 flex-[2_1_300px] flex-col gap-3">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            {t("calibration.bulk.range")}
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-[5px]">
              <span className="text-[12.5px] font-semibold text-ink-2">
                {t("calibration.bulk.from")}
              </span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={first}
                onChange={(event) => setFirst(event.target.value)}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-[5px]">
              <span className="text-[12.5px] font-semibold text-ink-2">
                {t("calibration.bulk.to")}{" "}
                <span className="font-normal text-ink-3">
                  {t("calibration.bulk.ofPages", { count: pageCount })}
                </span>
              </span>
              <input
                type="number"
                min={1}
                max={pageCount}
                value={last}
                onChange={(event) => setLast(event.target.value)}
                className={input}
              />
            </label>
          </div>

          {!range ? (
            <Notice tone="warn">{t("calibration.bulk.badRange", { count: pageCount })}</Notice>
          ) : plan.isError ? (
            <Notice tone="warn">
              {plan.error instanceof ApiError ? plan.error.message : t("calibration.requestFailed")}
            </Notice>
          ) : !current ? (
            <p className="m-0 text-[12.5px] text-ink-3">{t("calibration.bulk.planLoading")}</p>
          ) : (
            <PlanSummary plan={current} />
          )}

          <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] leading-snug">
            <input
              type="checkbox"
              checked={refresh}
              onChange={(event) => setRefresh(event.target.checked)}
              className="mt-0.5 h-[17px] w-[17px] flex-none cursor-pointer accent-lapis"
            />
            <span className="flex flex-col gap-0.5">
              <span>{t("calibration.bulk.refresh")}</span>
              <span className="text-[12px] text-ink-3">{t("calibration.bulk.refreshHelp")}</span>
            </span>
          </label>

          {current &&
            current.process + current.drafted > 0 &&
            readiness &&
            readiness.level !== "ready" && (
              <Notice tone="gold">{t("calibration.bulk.notReady")}</Notice>
            )}
          {busy && <Notice tone="warn">{t("calibration.bulk.running")}</Notice>}
          {lastBatch}
        </section>
      </div>

      <div className="flex flex-none flex-wrap justify-end gap-2.5 border-t border-rule-soft bg-sheet px-[26px] py-3.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={start.isPending}
          className={DIALOG_SECONDARY}
        >
          {t("calibration.bulk.cancel")}
        </button>
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={!current || count === 0 || busy || start.isPending || plan.isFetching}
          className={DIALOG_PRIMARY}
        >
          {start.isPending ? (
            <BusyLabel>{t("calibration.bulk.starting")}</BusyLabel>
          ) : current && current.process === 0 && current.drafted > 0 ? (
            t("calibration.bulk.startChanged")
          ) : (
            t("calibration.bulk.start", { count: current?.process ?? 0 })
          )}
        </button>
      </div>
    </>
  );
}

/** A note beside the form: warn, or the gold of a suggestion. */
function Notice({ tone, children }: { tone: "warn" | "gold"; children: ReactNode }) {
  return (
    <p
      className={`m-0 flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[12.5px] leading-normal ${
        tone === "warn" ? "bg-warn-wash text-warn-text" : "bg-gold-wash text-gold-text"
      }`}
    >
      {tone === "warn" ? (
        <TriangleAlert size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      ) : (
        <Info size={14} className="mt-0.5 flex-none" aria-hidden="true" />
      )}
      <span>{children}</span>
    </p>
  );
}

function parseRange(first: string, last: string, pageCount: number) {
  const from = Number(first);
  const to = Number(last);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1 || to > pageCount || from > to) return null;
  return { first: from, last: to };
}

function PlanSummary({ plan }: { plan: BatchPlan }) {
  const { t } = useTranslation();
  const duration = useDuration();
  const alone = LEFT_ALONE.filter((reason) => plan.pages[reason]?.length);
  const pages = plan.process + plan.drafted;
  return (
    <div className="flex flex-col gap-1.5 rounded-card bg-lapis-wash px-3.5 py-3 text-[12.5px] leading-normal text-ink-2">
      <span className="text-[14px] font-semibold text-lapis-text">
        {t("calibration.bulk.planProcess", { count: plan.process })}
      </span>
      {alone.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span>{t("calibration.bulk.leftAlone")}</span>
          <ul className="m-0 flex list-none flex-col gap-0.5 ps-3">
            {alone.map((reason) => (
              <li key={reason}>
                {t(`calibration.bulk.reason.${reason}`, { count: plan.pages[reason]!.length })}
                <span className="ms-1.5 font-mono text-[11.5px] text-ink-3" dir="ltr">
                  {ranges(plan.pages[reason]!)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pages > 0 && (
        <span>
          {plan.process_seconds !== null
            ? t("calibration.bulk.estimate", {
                time: duration(plan.process * plan.process_seconds),
                seconds: plan.process_seconds,
              })
            : t("calibration.bulk.estimateUnknown")}
        </span>
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
        <span className="text-[13px] font-semibold text-ink">
          {t("calibration.bulk.progressTitle", {
            first: job.page_range_start,
            last: job.page_range_end,
          })}
        </span>
        <span className="text-[12px] font-bold tabular-nums text-ink">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-lapis/15">
        <div className="h-full rounded-full bg-lapis transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[12.5px] leading-snug text-ink-2">
        {t("calibration.bulk.progressLine", { page: job.current_page ?? "…", processed, skipped })}
        {failed > 0 && ` · ${t("calibration.bulk.progressFailed", { count: failed })}`}
      </span>
      {perPage !== null && remaining > 0 && (
        <span className="text-[12px] text-ink-3">
          {t("calibration.bulk.progressLeft", { time: duration(remaining * perPage) })}
        </span>
      )}
      <button
        type="button"
        onClick={onStop}
        disabled={stopping}
        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-control border-[1.5px] border-stop bg-transparent text-[13px] font-semibold text-stop-text transition-colors hover:bg-stop-wash disabled:cursor-default disabled:opacity-60"
      >
        {stopping ? t("calibration.bulk.stopping") : t("calibration.bulk.stop")}
      </button>
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
    <div className="flex flex-col gap-0.5 text-[12px] leading-snug text-ink-3">
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
        <span className="text-stop-text" dir="auto">
          {t("calibration.bulk.failedPages", {
            pages: ranges(report.failed.map((entry) => entry.page)),
          })}
        </span>
      )}
    </div>
  );
}

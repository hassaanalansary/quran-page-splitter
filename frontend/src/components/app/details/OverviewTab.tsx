import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import type { ActivityEvent, MushafDetail, MushafStats } from "@/lib/api";

import { activityMeta, fmtDayTime, STEP_ROUTES, type StepInfo } from "./helpers";

export function OverviewTab({
  mushaf,
  steps,
  stats,
  activity,
  abortPage,
  onShowRuns,
  onShowPages,
}: {
  mushaf: MushafDetail;
  steps: StepInfo[];
  stats: MushafStats | undefined;
  activity: ActivityEvent[] | undefined;
  abortPage: number | null;
  onShowRuns: () => void;
  onShowPages: () => void;
}) {
  const { t } = useTranslation();
  const pct =
    mushaf.logical_page_count > 0
      ? Math.round((mushaf.processed_page_count / mushaf.logical_page_count) * 100)
      : 0;
  const avgLines =
    stats && mushaf.processed_page_count > 0
      ? (stats.lines_cut / mushaf.processed_page_count).toFixed(1)
      : "—";

  return (
    <div>
      {/* pipeline strip */}
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-2">
          {t("details.ov_pipeline")}
        </span>
        <span className="font-mono text-[10.5px] font-semibold text-ink-3">
          {abortPage
            ? t("details.ov_completeStopped", { pct, page: abortPage })
            : t("details.ov_complete", { pct })}
        </span>
      </div>
      <div className="flex overflow-hidden rounded-[10px] border border-rule bg-card">
        {steps.map((step, i) => (
          <PipelineCell
            key={step.slug}
            step={step}
            index={i + 1}
            mushafId={mushaf.id}
            last={i === steps.length - 1}
          />
        ))}
      </div>

      {/* activity + detected */}
      <div className="mt-4 grid grid-cols-[1.42fr_1fr] gap-4">
        <div className="overflow-hidden rounded-[11px] border border-rule bg-card">
          <div className="flex items-center border-b border-rule px-3.5 py-[11px]">
            <span className="text-[11px] font-semibold tracking-[0.02em] text-ink">
              {t("details.ov_activity")}
            </span>
            <button
              type="button"
              onClick={onShowRuns}
              className="ms-auto cursor-pointer text-[10.5px] font-semibold text-lapis-text hover:text-lapis-text/80"
            >
              {t("details.ov_runsLink")}
            </button>
          </div>
          <div className="max-h-[236px] overflow-auto">
            {!activity || activity.length === 0 ? (
              <div className="px-3.5 py-6 text-center text-[11px] text-ink-3">
                {t("details.ov_noActivity")}
              </div>
            ) : (
              activity.map((event, i) => (
                <ActivityRow key={event.id} event={event} first={i === 0} />
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col rounded-[11px] border border-rule bg-card">
          <div className="flex items-center border-b border-rule px-3.5 py-[11px]">
            <span className="text-[11px] font-semibold tracking-[0.02em] text-ink">
              {t("details.ov_detected")}
            </span>
            <button
              type="button"
              onClick={onShowPages}
              className="ms-auto cursor-pointer text-[10.5px] font-semibold text-lapis-text hover:text-lapis-text/80"
            >
              {t("details.ov_pagesLink")}
            </button>
          </div>
          <div className="px-3.5 pb-1.5 pt-1">
            <DetectedRow label={t("details.ov_ayatFound")} value={stats?.ayat_found} />
            <DetectedRow label={t("details.ov_linesCut")} value={stats?.lines_cut} />
            <DetectedRow label={t("details.ov_segments")} value={stats?.segments} />
            <DetectedRow label={t("details.ov_suraHeaders")} value={stats?.sura_headers} />
            <DetectedRow label={t("details.ov_besmellaLines")} value={stats?.besmella_lines} />
            <DetectedRow label={t("details.ov_avgLines")} value={avgLines} last />
          </div>
          {abortPage && (
            <div className="mx-3 mb-3 mt-auto flex items-start gap-2 rounded-lg border border-warn/25 bg-warn-wash px-[11px] py-[9px]">
              <span className="text-[11px] leading-[1.4]">⚠</span>
              <div className="text-[10.5px] leading-[1.5] text-warn-text">
                {t("details.ov_halted", { page: abortPage })}{" "}
                <Link
                  to="/mushafs/$mushafId/process"
                  params={{ mushafId: mushaf.id }}
                  className="font-bold underline"
                >
                  {t("details.ov_resume")}
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PipelineCell({
  step,
  index,
  mushafId,
  last,
}: {
  step: StepInfo;
  /** Position in the pipeline, 1-based. Passed down rather than looked up from
   * the slug: `pipelineSteps` already fixes the order, and a second copy of it
   * here silently loses its place the moment a step is added. */
  index: number;
  mushafId: string;
  last: boolean;
}) {
  const stateStyles =
    step.state === "done"
      ? "bg-done-wash hover:brightness-[0.98]"
      : step.state === "active"
        ? "bg-lapis-wash hover:bg-lapis/15"
        : "bg-card hover:bg-sheet";
  return (
    <Link
      to={STEP_ROUTES[step.slug]}
      params={{ mushafId }}
      className={`flex-1 px-[13px] py-[11px] transition ${stateStyles} ${last ? "" : "border-r border-rule"}`}
      style={
        step.state === "active" && step.slug === "process"
          ? { boxShadow: "inset 0 2px 0 var(--lapis)" }
          : undefined
      }
    >
      <div className="flex items-center gap-[7px]">
        <StepBadge step={step} index={index} />
        <span
          className={`text-[11.5px] font-bold ${step.state === "todo" ? "text-ink-2" : "text-ink"}`}
        >
          {step.label}
        </span>
      </div>
      <div
        className={`mt-1.5 text-[10px] leading-[1.4] ${
          step.warn ? "text-warn-text" : step.state === "todo" ? "text-ink-3" : "text-ink-2"
        }`}
      >
        {step.detail}
      </div>
    </Link>
  );
}

function StepBadge({ step, index }: { step: StepInfo; index: number }) {
  if (step.state === "done") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-done text-[10px] font-bold text-on-done">
        ✓
      </span>
    );
  }
  if (step.state === "active") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-lapis text-[10px] font-bold text-on-lapis">
        {index}
      </span>
    );
  }
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-rule-2 text-[10px] font-bold text-ink-3">
      {index}
    </span>
  );
}

function ActivityRow({ event, first }: { event: ActivityEvent; first: boolean }) {
  const meta = activityMeta(event);
  return (
    <div className={`flex items-start gap-2.5 px-3.5 py-2 ${first ? "" : "border-t border-sheet"}`}>
      <span className="w-[70px] flex-none font-mono text-[10px] font-semibold text-ink-3">
        {fmtDayTime(event.created_at)}
      </span>
      <span
        className="mt-1 h-[6px] w-[6px] flex-none rounded-full"
        style={{ background: meta.dot }}
      />
      <span className="text-[11.5px] leading-[1.4] text-ink">{meta.text}</span>
    </div>
  );
}

function DetectedRow({
  label,
  value,
  last,
}: {
  label: string;
  value: number | string | undefined;
  last?: boolean;
}) {
  return (
    <div className={`flex justify-between py-[7px] ${last ? "" : "border-b border-sheet"}`}>
      <span className="text-[11.5px] text-ink-2">{label}</span>
      <span className="font-mono text-[12.5px] font-bold text-ink">{value ?? "…"}</span>
    </div>
  );
}

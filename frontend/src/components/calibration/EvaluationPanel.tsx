import { useTranslation } from "react-i18next";
import { useState } from "react";
import { ScanLine } from "lucide-react";

import { ApiError, useCalibrationEvaluation } from "@/lib/api";
import { EvaluationComparison } from "./EvaluationComparison";
import type { CalibrationEvaluation, EvaluationCounts } from "@/lib/calibration/types";

const ENGINES = ["frozen", "canonical", "calibrated"] as const;
const METRICS = [
  "body_as_mark",
  "mark_as_body",
  "words_moved",
  "words_wrong_line",
  "words_missing",
  "words_duplicated",
  "words_extra",
] as const;

type Engine = (typeof ENGINES)[number];
type Metric = (typeof METRICS)[number];

/**
 * What calibration would have done on every confirmed page, measured against what
 * the reviewer confirmed there.
 *
 * Three readings side by side: the frozen engine as it ships, the full-line reading
 * the editor shows, and that same reading with calibration's proposals applied as
 * locks. Each page was proposed for only from pages confirmed *before* it, so every
 * later page is a test the earlier ones never saw. Nothing here switches anything
 * on — reading this table is the gate.
 *
 * Mounted only while its section is open: the server re-reads every confirmed page
 * to answer, which is not something to do on every visit.
 */
export function EvaluationPanel({ mushafId }: { mushafId: string }) {
  const { t } = useTranslation();
  const [comparisonPage, setComparisonPage] = useState<number | null>(null);
  const { data, isLoading, error } = useCalibrationEvaluation(mushafId, true);

  if (isLoading) {
    return <p className="text-[11.5px] text-text-muted">{t("calibration.evaluationLoading")}</p>;
  }
  if (error) {
    return (
      <p className="text-[11.5px] text-error">
        {error instanceof ApiError ? error.message : t("calibration.requestFailed")}
      </p>
    );
  }
  if (!data?.confirmed_pages) {
    return <p className="text-[11.5px] text-text-muted">{t("calibration.evaluationEmpty")}</p>;
  }

  const engineLabel = (engine: Engine) => t(`calibration.engine.${engine}`);
  const metricLabel = (metric: Metric) => t(`calibration.metric.${METRIC_KEYS[metric]}`);
  const proposals = sumProposals(data);
  const released = data.pages.reduce((total, entry) => total + entry.released_locks, 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10.5px] leading-snug text-text-muted">
        {t("calibration.evaluationIntro", { count: data.confirmed_pages })}
      </p>

      <table className="w-full border-collapse text-[11px] tabular-nums">
        <thead>
          <tr className="text-text-muted">
            <th />
            {ENGINES.map((engine) => (
              <th key={engine} className="px-1 pb-1 text-end font-semibold">
                {engineLabel(engine)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRICS.map((metric) => (
            <tr key={metric} className="border-t border-border">
              <th className="py-1 pe-2 text-start font-normal text-text-secondary">
                {metricLabel(metric)}
              </th>
              {ENGINES.map((engine) => (
                <td key={engine} className="px-1 py-1 text-end">
                  {count(data.totals[engine], metric)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
        <dt className="text-text-secondary">{t("calibration.proposedBody")}</dt>
        <dd>
          {t("calibration.proposalScore", {
            made: proposals.body.made,
            wrong: proposals.body.wrong,
          })}
        </dd>
        <dt className="text-text-secondary">{t("calibration.proposedMark")}</dt>
        <dd>
          {t("calibration.proposalScore", {
            made: proposals.mark.made,
            wrong: proposals.mark.wrong,
          })}
        </dd>
        <dt className="text-text-secondary">{t("calibration.releasedLocks")}</dt>
        <dd>{released}</dd>
      </dl>

      <details className="text-[11px]">
        <summary className="cursor-pointer text-text-secondary">
          {t("calibration.evaluationPages", { count: data.pages.length })}
        </summary>
        <table className="mt-1 w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-text-muted">
              <th className="text-start font-semibold">{t("calibration.evaluationPage")}</th>
              {ENGINES.map((engine) => (
                <th key={engine} className="px-1 text-end font-semibold">
                  {engineLabel(engine)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.pages.map((entry) => (
              <tr key={entry.page} className="border-t border-border">
                <td className="py-0.5">
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 text-orange"
                    title={t("calibration.comparePage", { page: entry.page })}
                    onClick={() => setComparisonPage(entry.page)}
                  >
                    <ScanLine size={13} />
                    {entry.page}
                  </button>
                </td>
                {ENGINES.map((engine) => (
                  <td
                    key={engine}
                    className="px-1 py-0.5 text-end"
                    title={t("calibration.pageErrorsHelp")}
                  >
                    {errors(entry.results[engine])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <p className="text-[10.5px] leading-snug text-text-muted">
        {data.activation_allowed ? t("calibration.gateOpen") : t("calibration.gateShadow")}
      </p>
      <EvaluationComparison
        mushafId={mushafId}
        page={comparisonPage}
        onClose={() => setComparisonPage(null)}
      />
    </div>
  );
}

const METRIC_KEYS = {
  body_as_mark: "bodyAsMark",
  mark_as_body: "markAsBody",
  words_moved: "wordsMoved",
  words_wrong_line: "wordsWrongLine",
  words_missing: "wordsMissing",
  words_duplicated: "wordsDuplicated",
  words_extra: "wordsExtra",
} as const;

/** A count, or a dash where that reading does not measure it — the frozen engine
 * never labels blobs, so it has no role errors to count. */
function count(counts: EvaluationCounts | undefined, metric: Metric): string {
  const value = counts?.[metric];
  return value === undefined ? "—" : String(value);
}

/** Everything a reading got wrong on one page, as one number per reading. */
function errors(counts: EvaluationCounts | undefined): string {
  if (!counts) return "—";
  return String(METRICS.reduce((total, metric) => total + (counts[metric] ?? 0), 0));
}

function sumProposals(data: CalibrationEvaluation) {
  const total = { body: { made: 0, wrong: 0 }, mark: { made: 0, wrong: 0 } };
  for (const entry of data.pages) {
    for (const role of ["body", "mark"] as const) {
      total[role].made += entry.proposals[role]?.made ?? 0;
      total[role].wrong += entry.proposals[role]?.wrong ?? 0;
    }
  }
  return total;
}

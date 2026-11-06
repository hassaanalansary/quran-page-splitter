import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SatrDialog } from "@/components/app/SatrDialog";
import { PHASES } from "@/components/app/shell/context";
import {
  REQUIRED_TEMPLATE_TYPES,
  TEMPLATE_TYPES,
  type ActivityEvent,
  type MushafDetail,
  type MushafStats,
  type PageSummary,
  type Template,
} from "@/lib/api";
import type { CalibrationPageState } from "@/lib/calibration/types";

import {
  activityMeta,
  fmtDate,
  fmtDayTime,
  humanSize,
  shortId,
  STEP_ROUTES,
  type StepInfo,
  type StepSlug,
} from "./helpers";

/** A big card of the Overview's main column: a Reem Kufi title, a note beside it. */
function MainCard({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3.5 rounded-panel border border-rule bg-card p-[22px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 font-display text-[22px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A side card: a title row with a link, then its body. */
function SideCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-panel border border-rule bg-card">
      <div className="flex items-center justify-between border-b border-rule-soft px-[18px] py-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const SIDE_LINK =
  "cursor-pointer text-[13px] font-semibold text-lapis-text no-underline hover:text-lapis-text/80";

export function OverviewTab({
  mushaf,
  steps,
  stats,
  activity,
  summaries,
  templates,
  nextPage,
  calibrationPages,
  abortPage,
  onShowRuns,
  onShowPages,
}: {
  mushaf: MushafDetail;
  steps: StepInfo[];
  stats: MushafStats | undefined;
  activity: ActivityEvent[] | undefined;
  summaries: PageSummary[] | undefined;
  templates: Template[] | undefined;
  /** The page Continue would open in Review, picked out on the coverage map. */
  nextPage: number | null;
  calibrationPages: CalibrationPageState[] | undefined;
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
      ? (stats.lines_cut / mushaf.processed_page_count).toFixed(2)
      : "—";

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <MainCard
          title={t("details.ov_pipeline")}
          aside={
            <span className="font-mono text-[13px] text-ink-3">
              {abortPage
                ? t("details.ov_completeStopped", { pct, page: abortPage })
                : t("details.ov_complete", { pct })}
            </span>
          }
        >
          <PipelineGrid
            mushaf={mushaf}
            steps={steps}
            stats={stats}
            calibrationPages={calibrationPages}
          />
        </MainCard>

        <MainCard
          title={t("details.rail_coverage")}
          aside={
            <CoverageLegend
              reviewed={mushaf.reviewed_page_count}
              processed={mushaf.processed_page_count - mushaf.reviewed_page_count}
              next={nextPage !== null}
            />
          }
        >
          <CoverageMap
            mushafId={mushaf.id}
            logical={mushaf.logical_page_count}
            summaries={summaries}
            nextPage={nextPage}
          />
          <span className="text-[12.5px] text-ink-3">{t("hub.coverageHint")}</span>
        </MainCard>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 font-display text-[22px] font-semibold">
              {t("details.ov_detected")}
            </h2>
            <button type="button" onClick={onShowPages} className={SIDE_LINK}>
              {t("details.ov_pagesLink")}
            </button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded-panel border border-rule bg-rule">
            {(
              [
                [stats?.ayat_found, t("details.ov_ayatFound")],
                [stats?.lines_cut, t("details.ov_linesCut")],
                [stats?.segments, t("details.ov_segments")],
                [stats?.sura_headers, t("details.ov_suraHeaders")],
                [stats?.besmella_lines, t("details.ov_besmellaLines")],
                [avgLines, t("details.ov_avgLines")],
              ] as const
            ).map(([value, label]) => (
              <div key={label} className="flex flex-col gap-1 bg-card px-[18px] py-4">
                <span className="font-display text-[28px] font-semibold leading-[1.1]">
                  {value === undefined
                    ? "…"
                    : typeof value === "number"
                      ? value.toLocaleString()
                      : value}
                </span>
                <span className="text-[12.5px] text-ink-3">{label}</span>
              </div>
            ))}
          </div>
          {abortPage && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/25 bg-warn-wash px-3.5 py-2.5 text-[13px] leading-normal text-warn-text">
              <span aria-hidden="true">⚠</span>
              <span>
                {t("details.ov_halted", { page: abortPage })}{" "}
                <Link
                  to="/mushafs/$mushafId/process"
                  params={{ mushafId: mushaf.id }}
                  className="font-bold underline"
                >
                  {t("details.ov_resume")}
                </Link>
              </span>
            </div>
          )}
        </section>
      </div>

      <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
        <TemplatesCard mushafId={mushaf.id} templates={templates} />

        <SideCard title={t("details.rail_record")}>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-[9px] px-[18px] pb-4 pt-3.5 text-[13.5px]">
            {(
              [
                [
                  t("details.rail_quranRange"),
                  t("details.rail_quranRangeValue", {
                    first: mushaf.first_quran_pdf_page,
                    last: mushaf.last_quran_pdf_page,
                  }),
                  true,
                ],
                [t("details.rail_logicalPages"), String(mushaf.logical_page_count), true],
                [t("details.rail_file"), mushaf.pdf_original_name || "—", false],
                [t("details.rail_size"), humanSize(mushaf.pdf_file_size), true],
                [t("details.rail_uploaded"), fmtDate(mushaf.created_at), false],
                [t("details.rail_id"), shortId(mushaf.id), true],
              ] as const
            ).map(([label, value, mono]) => (
              <div key={label} className="contents">
                <dt className="text-ink-3">{label}</dt>
                <dd
                  title={value}
                  className={`m-0 min-w-0 truncate text-end ${mono ? "font-mono" : ""} ${
                    label === t("details.rail_id") ? "text-ink-3" : ""
                  }`}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </SideCard>

        <SideCard
          title={t("details.ov_activity")}
          action={
            <button type="button" onClick={onShowRuns} className={SIDE_LINK}>
              {t("details.ov_runsLink")}
            </button>
          }
        >
          <ol className="m-0 flex max-h-[360px] list-none flex-col overflow-auto px-[18px] pb-3.5 pt-2">
            {!activity || activity.length === 0 ? (
              <li className="py-4 text-center text-[13px] text-ink-3">
                {t("details.ov_noActivity")}
              </li>
            ) : (
              activity.map((event) => {
                const meta = activityMeta(event);
                return (
                  <li
                    key={event.id}
                    className="flex items-start gap-3 border-b border-rule-soft py-2.5 last:border-b-0"
                  >
                    <span
                      className="mt-1.5 h-2 w-2 flex-none rounded-full"
                      style={{ background: meta.dot }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13.5px] leading-snug">{meta.text}</span>
                      <span className="text-[12px] text-ink-4">{fmtDayTime(event.created_at)}</span>
                    </span>
                  </li>
                );
              })
            )}
          </ol>
        </SideCard>
      </aside>
    </div>
  );
}

/** How far each step is, 0–1, from the counts the hub already holds. */
function stepShare(
  slug: StepSlug,
  step: StepInfo | undefined,
  mushaf: MushafDetail,
  stats: MushafStats | undefined,
  calibrationPages: CalibrationPageState[] | undefined,
): number {
  const of = (done: number, total: number) => (total > 0 ? Math.min(1, done / total) : 0);
  switch (slug) {
    case "setup":
    case "templates":
      return step?.state === "done" ? 1 : 0;
    case "process":
      return of(mushaf.processed_page_count, mushaf.logical_page_count);
    case "review":
      return of(mushaf.reviewed_page_count, mushaf.processed_page_count);
    case "finalize":
      return of(stats?.exported_pngs ?? 0, stats?.lines_cut ?? 0);
    case "ink":
      return of(
        (calibrationPages ?? []).filter((page) => page.processed).length,
        mushaf.logical_page_count,
      );
  }
}

/** The three phases side by side, each step with its sub-line and bar. */
function PipelineGrid({
  mushaf,
  steps,
  stats,
  calibrationPages,
}: {
  mushaf: MushafDetail;
  steps: StepInfo[];
  stats: MushafStats | undefined;
  calibrationPages: CalibrationPageState[] | undefined;
}) {
  const { t } = useTranslation();
  const bySlug = new Map(steps.map((step) => [step.slug, step]));
  const order = PHASES.flatMap((phase) => phase.steps);
  // The first step not done yet is the one being worked on: gold, like Continue.
  const current = steps.find((step) => step.state !== "done")?.slug;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
      {PHASES.map((phase) => {
        const shares = phase.steps.map((slug) =>
          stepShare(slug, bySlug.get(slug), mushaf, stats, calibrationPages),
        );
        const phasePct = Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 100);
        return (
          <div
            key={phase.key}
            className="flex flex-col gap-3 rounded-card border border-rule-soft bg-sheet p-4"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                {t(`shell.phase.${phase.key}`)}
              </span>
              <span className="font-mono text-[12px] text-ink-3">{phasePct}%</span>
            </div>
            {phase.steps.map((slug, i) => {
              const step = bySlug.get(slug);
              const share = shares[i];
              const tone =
                step?.state === "done" ? "bg-done" : slug === current ? "bg-gold" : "bg-lapis";
              return (
                <Link
                  key={slug}
                  to={STEP_ROUTES[slug]}
                  params={{ mushafId: mushaf.id }}
                  className="group flex flex-col gap-1.5 text-ink no-underline"
                >
                  <span className="flex justify-between gap-2 text-[14px]">
                    <span className="font-semibold group-hover:text-lapis-text">
                      {order.indexOf(slug) + 1} · {t(`header.steps.${slug}`)}
                    </span>
                    {step && (
                      <span
                        className={`truncate text-[12.5px] ${step.warn ? "text-warn-text" : "text-ink-3"}`}
                      >
                        {step.detail}
                      </span>
                    )}
                  </span>
                  <span className="h-[5px] rounded-[3px] bg-sunk">
                    <span
                      className={`block h-[5px] rounded-[3px] ${tone}`}
                      style={{ width: `${share * 100}%` }}
                    />
                  </span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function CoverageLegend({
  reviewed,
  processed,
  next,
}: {
  reviewed: number;
  processed: number;
  next: boolean;
}) {
  const { t } = useTranslation();
  const item = (color: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-[2px] ${color}`} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-3.5 text-[12.5px] text-ink-2">
      {item("bg-done", t("hub.legendReviewed", { count: reviewed }))}
      {item("bg-lapis", t("hub.legendProcessed", { count: processed }))}
      {next && item("bg-gold", t("hub.legendNext"))}
    </div>
  );
}

/** Every Quran page as a square: reviewed, processed, the next to review, or not
 * reached yet. Each opens its page in Review. */
function CoverageMap({
  mushafId,
  logical,
  summaries,
  nextPage,
}: {
  mushafId: string;
  logical: number;
  summaries: PageSummary[] | undefined;
  nextPage: number | null;
}) {
  const { t } = useTranslation();
  const byPage = new Map((summaries ?? []).map((s) => [s.page_number, s]));
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,11px)] gap-[2px]"
      role="img"
      aria-label={t("details.rail_coverageAria")}
    >
      {Array.from({ length: logical }, (_, i) => {
        const n = i + 1;
        const row = byPage.get(n);
        const color =
          n === nextPage ? "bg-gold" : row ? (row.reviewed ? "bg-done" : "bg-lapis") : "bg-sunk";
        const state = row
          ? row.reviewed
            ? t("details.state_reviewed")
            : t("details.state_processed")
          : t("details.state_notProcessed");
        return (
          <Link
            key={n}
            to="/mushafs/$mushafId/review"
            params={{ mushafId }}
            search={{ page: n }}
            title={t("details.rail_pageState", { n, state })}
            className={`block h-[11px] w-[11px] rounded-[2px] ${color} hover:outline hover:outline-2 hover:outline-lapis`}
          />
        );
      })}
    </div>
  );
}

/** The captured templates, each opening full size. */
function TemplatesCard({
  mushafId,
  templates,
}: {
  mushafId: string;
  templates: Template[] | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Template | null>(null);

  return (
    <SideCard
      title={t("details.rail_templates")}
      action={
        <Link to="/mushafs/$mushafId/templates" params={{ mushafId }} className={SIDE_LINK}>
          {t("details.rail_edit")}
        </Link>
      }
    >
      <div className="flex flex-col gap-2.5 px-[18px] pb-4 pt-3.5">
        {TEMPLATE_TYPES.map((type) => {
          const template = templates?.find((row) => row.type === type);
          const optional = !(REQUIRED_TEMPLATE_TYPES as readonly string[]).includes(type);
          const masked = !!template && Object.keys(template.ignore_rects).length > 0;
          const label = t(`templates.name_${type}`);
          const sub = [
            optional ? t("hub.tplOptional") : null,
            template
              ? masked
                ? type === "sura_header"
                  ? t("hub.tplVariableArea")
                  : t("hub.tplMasked")
                : t("hub.tplCaptured")
              : optional
                ? null
                : t("details.rail_notCaptured"),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={type} className="flex items-center gap-3">
              {template ? (
                <button
                  type="button"
                  onClick={() => setOpen(template)}
                  title={t("details.rail_templateAlt", { label })}
                  className="flex h-10 w-32 flex-none cursor-zoom-in items-center justify-center overflow-hidden rounded-[5px] border border-rule-2 bg-white"
                >
                  <img
                    src={template.image_url}
                    alt={t("details.rail_templateAlt", { label })}
                    className="max-h-full max-w-full object-contain"
                  />
                </button>
              ) : (
                <span className="flex h-10 w-32 flex-none items-center justify-center rounded-[5px] border border-dashed border-rule-2 text-[12px] text-ink-4">
                  {t("details.rail_notCaptured")}
                </span>
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[14px] font-semibold">{label}</span>
                {sub && <span className="text-[12px] text-ink-3">{sub}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <SatrDialog
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        title={open ? t(`templates.name_${open.type}`) : ""}
        width={760}
      >
        {open && (
          // A template is a crop of the scan: it stays on white, as the page does.
          <div className="flex justify-center rounded-lg bg-white p-3">
            <img
              src={open.image_url}
              alt={t("details.rail_templateAlt", { label: t(`templates.name_${open.type}`) })}
              className="max-h-[60vh] max-w-full object-contain"
            />
          </div>
        )}
      </SatrDialog>
    </SideCard>
  );
}

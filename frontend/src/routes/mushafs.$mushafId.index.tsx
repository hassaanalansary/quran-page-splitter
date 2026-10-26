import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MushafHeader } from "@/components/app/MushafHeader";
import { LoadingState } from "@/components/app/SatrLoader";
import { DetailsRail } from "@/components/app/details/DetailsRail";
import { ExportTab } from "@/components/app/details/ExportTab";
import { continueTarget, pipelineSteps, runAbortPage } from "@/components/app/details/helpers";
import { OverviewTab } from "@/components/app/details/OverviewTab";
import { PagesTab } from "@/components/app/details/PagesTab";
import { RunsTab } from "@/components/app/details/RunsTab";
import { SettingsTab } from "@/components/app/details/SettingsTab";
import {
  useActivity,
  useCalibrationPages,
  useMushaf,
  usePageSummaries,
  useRuns,
  useStats,
  useTemplates,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/")({ component: MushafDetailsPage });

type Tab = "overview" | "pages" | "runs" | "export" | "settings";

const TAB_IDS: Tab[] = ["overview", "pages", "runs", "export", "settings"];

function MushafDetailsPage() {
  const { t } = useTranslation();
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/" });
  const { data: mushaf, isPending, isError, error } = useMushaf(mushafId);
  const { data: stats } = useStats(mushafId);
  const { data: summaries } = usePageSummaries(mushafId);
  const { data: runs } = useRuns(mushafId);
  const { data: activity } = useActivity(mushafId);
  const { data: templates } = useTemplates(mushafId);
  const { data: calibrationPages } = useCalibrationPages(mushafId);
  const [tab, setTab] = useState<Tab>("overview");

  const templatesReady =
    !!templates &&
    ["sura_header", "aya_separator"].every((t) => templates.some((tpl) => tpl.type === t));

  // "stopped at p.N" comes from the latest run only if it aborted.
  const abortPage = useMemo(() => {
    const latest = runs?.[0];
    return latest && latest.status === "aborted_line_detection" ? runAbortPage(latest) : null;
  }, [runs]);

  if (isPending)
    return (
      <Centered>
        <LoadingState>{t("workspace.loadingMushaf")}</LoadingState>
      </Centered>
    );
  if (isError || !mushaf) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3">
          <span className="text-stop-text">
            {error instanceof Error ? error.message : t("workspace.loadFailed")}
          </span>
          {/* Reaching a mushaf that isn't yours lands here, so there has to be a
              way out — otherwise the only option is the browser's back button. */}
          <Link to="/" className="text-[12.5px] font-semibold text-lapis-text hover:underline">
            {t("header.allMushafs")}
          </Link>
        </div>
      </Centered>
    );
  }

  const steps = pipelineSteps(mushaf, templatesReady, stats, abortPage, calibrationPages);
  const cta = continueTarget(mushaf, templatesReady, summaries, stats, calibrationPages);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-paper">
      <MushafHeader mushaf={mushaf} activeSlug={null} cta={cta} />

      <div className="grid min-h-0 flex-1 grid-cols-[282px_1fr]">
        <DetailsRail mushaf={mushaf} stats={stats} summaries={summaries} templates={templates} />

        <div className="flex min-w-0 flex-col overflow-y-auto">
          {/* tab bar */}
          <div className="flex flex-shrink-0 items-center gap-6 border-b border-rule bg-card px-5">
            {TAB_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex h-[42px] cursor-pointer items-center gap-2 border-b-2 px-0.5 text-[12.5px] font-semibold tracking-[0.01em] transition-colors ${
                  tab === id
                    ? "border-lapis text-lapis-text"
                    : "border-transparent text-ink-3 hover:text-ink-2"
                }`}
              >
                {t(`details.tab_${id}`)}
                {id === "pages" && summaries && summaries.length > 0 && (
                  <CountChip n={summaries.length} />
                )}
                {id === "runs" && runs && runs.length > 0 && <CountChip n={runs.length} />}
              </button>
            ))}
          </div>

          {/* tab body */}
          <div className="min-h-0 flex-1 overflow-y-auto bg-paper px-5 pb-6 pt-[18px]">
            {tab === "overview" && (
              <OverviewTab
                mushaf={mushaf}
                steps={steps}
                stats={stats}
                activity={activity}
                abortPage={abortPage}
                onShowRuns={() => setTab("runs")}
                onShowPages={() => setTab("pages")}
              />
            )}
            {tab === "pages" && (
              <PagesTab
                mushafId={mushafId}
                summaries={summaries}
                remaining={mushaf.logical_page_count - mushaf.processed_page_count}
                abortPage={abortPage}
              />
            )}
            {tab === "runs" && <RunsTab mushafId={mushafId} runs={runs} />}
            {tab === "export" && <ExportTab mushaf={mushaf} stats={stats} summaries={summaries} />}
            {tab === "settings" && <SettingsTab key={mushaf.updated_at} mushaf={mushaf} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function CountChip({ n }: { n: number }) {
  return (
    <span className="rounded-[10px] bg-sunk px-1.5 py-px font-mono text-[9.5px] font-bold text-ink-2">
      {n}
    </span>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center bg-paper text-sm text-ink-2">
      {children}
    </div>
  );
}

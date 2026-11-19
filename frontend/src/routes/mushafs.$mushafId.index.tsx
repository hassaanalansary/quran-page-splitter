import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, HubSkeleton, STATE_SECONDARY } from "@/components/app/States";
import { ExportTab } from "@/components/app/details/ExportTab";
import { HubBand, HubTopBar } from "@/components/app/details/HubHeader";
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
      <div className="flex h-screen w-full flex-col overflow-hidden bg-paper">
        <HubSkeleton />
      </div>
    );
  if (isError || !mushaf) {
    return (
      <Centered>
        {/* Reaching a mushaf that isn't yours lands here, so there has to be a
            way out — otherwise the only option is the browser's back button. */}
        <ErrorState
          title={t("workspace.loadFailed")}
          body={error instanceof Error ? error.message : undefined}
          className="w-full max-w-[420px]"
        >
          <Link to="/" className={STATE_SECONDARY}>
            {t("header.allMushafs")}
          </Link>
        </ErrorState>
      </Centered>
    );
  }

  const steps = pipelineSteps(mushaf, templatesReady, abortPage, calibrationPages);
  const cta = continueTarget(mushaf, templatesReady, summaries, stats, calibrationPages);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-paper">
      <HubTopBar mushaf={mushaf} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <HubBand mushaf={mushaf} stats={stats} steps={steps} cta={cta} />

        <div className="border-b border-rule bg-sheet">
          <div
            role="tablist"
            aria-label={t("hub.sections")}
            className="mx-auto flex max-w-[1240px] gap-[26px] overflow-x-auto px-7"
          >
            {TAB_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex h-[50px] flex-none cursor-pointer items-center gap-2 border-b-2 text-[14.5px] transition-colors ${
                  tab === id
                    ? "border-ink font-semibold text-ink"
                    : "border-transparent font-medium text-ink-3 hover:text-ink-2"
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
        </div>

        <div role="tabpanel" className="mx-auto w-full max-w-[1240px] px-7 pb-10 pt-[26px]">
          {tab === "overview" && (
            <OverviewTab
              mushaf={mushaf}
              steps={steps}
              stats={stats}
              activity={activity}
              summaries={summaries}
              templates={templates}
              nextPage={cta.slug === "review" ? (cta.reviewPage ?? null) : null}
              calibrationPages={calibrationPages}
              abortPage={abortPage}
              onShowRuns={() => setTab("runs")}
              onShowPages={() => setTab("pages")}
            />
          )}
          {tab === "pages" && (
            <PagesTab
              mushafId={mushafId}
              summaries={summaries}
              calibrationPages={calibrationPages}
              logical={mushaf.logical_page_count}
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
  );
}

function CountChip({ n }: { n: number }) {
  return (
    <span className="rounded-pill bg-sunk px-[7px] py-px font-mono text-[11.5px] text-ink-2">
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

import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { OrnamentStrip } from "@/components/app/Ornament";
import type { StepSlug } from "@/components/app/details/helpers";
import { pageImageUrl, type MushafDetail } from "@/lib/api";

import { PHASES, STEP_ROUTES, useStepStates, type StepStates } from "./context";

/** The identity block's line and bar: the progress of the phase you are in. */
function phaseProgress(
  slug: StepSlug,
  mushaf: MushafDetail,
  states: StepStates,
): { kind: "processed" | "reviewed" | "exported" | "ink"; done: number; total: number } {
  if (slug === "review") {
    return { kind: "reviewed", done: mushaf.reviewed_page_count, total: mushaf.logical_page_count };
  }
  if (slug === "finalize") {
    return {
      kind: "exported",
      done: states.stats?.exported_pngs ?? 0,
      total: states.stats?.lines_cut ?? 0,
    };
  }
  if (slug === "ink") {
    return { kind: "ink", done: states.inkProcessed, total: mushaf.logical_page_count };
  }
  return { kind: "processed", done: mushaf.processed_page_count, total: mushaf.logical_page_count };
}

/**
 * The spine: the mushaf's identity block on deep lapis (cover, the way back to its
 * overview, the progress of the phase you are in), then every step in its phase
 * with its number (✓ once done) and a live sub-line, the current one picked out.
 * On narrow screens it collapses to a row above the canvas.
 */
export function Spine({ mushaf, active }: { mushaf: MushafDetail; active: StepSlug }) {
  const { t } = useTranslation();
  const states = useStepStates(mushaf);
  const [coverFailed, setCoverFailed] = useState(false);
  const progress = phaseProgress(active, mushaf, states);
  const share = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  const progressText =
    progress.kind === "ink"
      ? (states.steps.get("ink")?.detail ?? "")
      : progress.kind === "reviewed"
        ? t("shell.progressReviewed", { done: progress.done, total: progress.total })
        : progress.kind === "exported"
          ? t("shell.progressExported", { done: progress.done, total: progress.total })
          : t("shell.progressProcessed", { done: progress.done, total: progress.total });

  return (
    <nav
      aria-label={t("shell.pipeline")}
      className="flex w-[236px] flex-none flex-col overflow-y-auto border-e border-rule bg-sheet max-lg:w-full max-lg:flex-row max-lg:items-stretch max-lg:overflow-x-auto max-lg:overflow-y-hidden max-lg:border-b max-lg:border-e-0"
    >
      <div className="flex-none bg-deep text-on-deep max-lg:w-[236px]">
        <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
          <span className="h-[46px] w-[34px] flex-none overflow-hidden bg-page shadow-[0_3px_8px_rgba(0,0,0,0.3)]">
            {!coverFailed && (
              <img
                src={mushaf.thumbnail_url ?? pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
                alt=""
                draggable={false}
                onError={() => setCoverFailed(true)}
                className="h-full w-full object-cover object-top"
              />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <Link
              to="/mushafs/$mushafId"
              params={{ mushafId: mushaf.id }}
              className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-on-deep no-underline hover:underline"
            >
              <ChevronLeft className="h-3.5 w-3.5 flex-none rtl:rotate-180" aria-hidden="true" />
              {t("shell.overview")}
            </Link>
            <span className="h-1 rounded-[2px] bg-on-deep/[0.16]">
              <span
                className="block h-1 rounded-[2px] bg-gold"
                style={{ width: `${share * 100}%` }}
              />
            </span>
            <span className="text-[11.5px] text-on-deep-2">{progressText}</span>
          </span>
        </div>
        <OrnamentStrip height={8} />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 px-2.5 pb-3 pt-2 max-lg:flex-row max-lg:items-center max-lg:gap-4 max-lg:py-2">
        {PHASES.map((phase) => (
          <div
            key={phase.key}
            className="flex flex-col gap-0.5 max-lg:flex-row max-lg:items-center"
          >
            <span className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4 max-lg:hidden">
              {t(`shell.phase.${phase.key}`)}
            </span>
            {phase.steps.map((slug) => {
              const info = states.steps.get(slug);
              const current = slug === active;
              const done = !current && info?.state === "done";
              const number = PHASES.flatMap((p) => p.steps).indexOf(slug) + 1;
              return (
                <Link
                  key={slug}
                  to={STEP_ROUTES[slug]}
                  params={{ mushafId: mushaf.id }}
                  aria-current={current ? "page" : undefined}
                  className={`flex items-center gap-[11px] rounded-[7px] px-2.5 py-2 no-underline transition-colors ${
                    current ? "bg-lapis-wash text-lapis-text" : "text-ink hover:bg-sunk"
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-[12px] font-bold ${
                      current
                        ? "bg-lapis text-on-lapis"
                        : done
                          ? "bg-done text-on-done"
                          : "border-[1.5px] border-faint text-ink-3"
                    }`}
                  >
                    {done ? "✓" : number}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className={`text-[14px] ${current ? "font-semibold" : "font-medium"}`}>
                      {t(`header.steps.${slug}`)}
                    </span>
                    {info && (
                      <span
                        className={`truncate text-[12px] max-lg:hidden ${
                          info.warn ? "text-warn-text" : current ? "text-lapis-text" : "text-ink-3"
                        }`}
                      >
                        {info.detail}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

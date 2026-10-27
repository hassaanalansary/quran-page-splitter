import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LanguageButton } from "@/components/app/LanguageSwitcher";
import { OrnamentStrip } from "@/components/app/Ornament";
import { SatrLockup } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";
import { UserMenu } from "@/components/app/UserMenu";
import { PHASES } from "@/components/app/shell/context";
import {
  coordinatesUrl,
  mushafStatus,
  pageImageUrl,
  type MushafDetail,
  type MushafStats,
  type MushafStatus,
} from "@/lib/api";

import { STEP_ROUTES, type StepInfo, type StepSlug } from "./helpers";

/** The hub's top bar: the lockup, then the breadcrumb back to the library. */
export function HubTopBar({ mushaf }: { mushaf: MushafDetail | null }) {
  const { t } = useTranslation();
  return (
    <header className="flex min-h-[60px] flex-shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-rule bg-sheet px-7 py-2.5">
      <Link to="/" aria-label={t("shell.allMushafs")} className="flex items-center">
        <SatrLockup size={28} />
      </Link>
      <nav
        aria-label={t("hub.breadcrumb")}
        className="flex min-w-0 items-center gap-2.5 text-[14px]"
      >
        <span className="text-faint" aria-hidden="true">
          /
        </span>
        <Link to="/" className="text-ink-2 no-underline hover:text-ink">
          {t("gallery.myMushafs")}
        </Link>
        {mushaf && (
          <>
            <span className="text-faint" aria-hidden="true">
              /
            </span>
            <span aria-current="page" dir="auto" className="truncate font-semibold">
              {mushaf.name}
            </span>
          </>
        )}
      </nav>
      <div className="ms-auto flex items-center gap-2">
        <Link
          to="/gallery"
          className="inline-flex h-9 items-center px-3 text-[13.5px] font-medium text-ink-2 no-underline hover:text-ink"
        >
          {t("gallery.navLink")}
        </Link>
        <ThemeButton size={36} />
        <LanguageButton size={36} />
        <UserMenu size={36} />
      </div>
    </header>
  );
}

const STATUS_DOT: Record<MushafStatus, string> = {
  empty: "bg-ink-4",
  partial: "bg-gold",
  processed: "bg-lapis",
  completed: "bg-done",
};

/** A labelled 6 px bar on the deep band. */
function BandBar({
  label,
  done,
  total,
  tone,
}: {
  label: string;
  done: number;
  total: number;
  tone: "plain" | "gold";
}) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="flex justify-between text-[12.5px]">
        <span className="text-on-deep-2">{label}</span>
        <span className="font-mono">
          {done} / {total}
        </span>
      </div>
      <div className="h-1.5 rounded-[3px] bg-on-deep/[0.14]">
        <div
          className={`h-1.5 rounded-[3px] ${tone === "gold" ? "bg-gold" : "bg-on-deep-2"}`}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The deep identity band at the top of the hub: the cover, name, status and what
 * the mushaf is; processed and reviewed; the three counts; Continue with where it
 * leads, the PDF and the JSON; then every step in its phase, the next one ringed
 * in gold.
 */
export function HubBand({
  mushaf,
  stats,
  steps,
  cta,
}: {
  mushaf: MushafDetail;
  stats: MushafStats | undefined;
  steps: StepInfo[];
  cta: { slug: StepSlug; sub: string; reviewPage?: number };
}) {
  const { t } = useTranslation();
  const [coverFailed, setCoverFailed] = useState(false);
  const status = mushafStatus(mushaf);
  const bySlug = new Map(steps.map((step) => [step.slug, step]));
  const order = PHASES.flatMap((phase) => phase.steps);
  const facts = [
    mushaf.qiraa ?? t("details.rail_noQiraa"),
    mushaf.counting_system &&
      t("hub.counting", {
        name: mushaf.counting_system.name,
        total: mushaf.counting_system.total_ayat.toLocaleString(),
      }),
    t("hub.quranPages", { count: mushaf.logical_page_count }),
  ].filter(Boolean);
  const quiet =
    "inline-flex h-8 flex-1 items-center justify-center rounded-control border border-on-deep/30 px-3 text-[12.5px] font-semibold text-on-deep no-underline transition-colors hover:bg-on-deep/10";

  return (
    <section className="bg-deep text-on-deep">
      <OrnamentStrip />
      <div className="mx-auto flex max-w-[1240px] flex-col gap-[22px] px-7 pb-[22px] pt-6">
        <div className="flex flex-wrap items-center gap-x-9 gap-y-5">
          <div className="flex flex-[1_1_340px] items-center gap-[18px]">
            <span className="h-[104px] w-[78px] flex-none overflow-hidden bg-page shadow-[0_8px_20px_rgba(0,0,0,0.35)]">
              {!coverFailed && (
                <img
                  src={mushaf.thumbnail_url ?? pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
                  alt={t("details.rail_coverAlt", { name: mushaf.name })}
                  draggable={false}
                  onError={() => setCoverFailed(true)}
                  className="h-full w-full object-cover object-top"
                />
              )}
            </span>
            <div className="flex min-w-0 flex-col gap-[7px]">
              <div className="flex flex-wrap items-center gap-3">
                <h1 dir="auto" className="m-0 font-display text-[36px] font-semibold leading-none">
                  {mushaf.name}
                </h1>
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-on-deep/[0.12] px-2.5 py-[3px] text-[12.5px] font-semibold text-on-deep">
                  <span className={`h-[7px] w-[7px] rounded-full ${STATUS_DOT[status]}`} />
                  {t(`status.${status}`)}
                </span>
              </div>
              <span className="text-[14px] capitalize text-on-deep-2">{facts.join(" · ")}</span>
            </div>
          </div>

          <div className="flex min-w-[220px] flex-[1_1_260px] flex-col gap-2.5">
            <BandBar
              label={t("details.rail_processed")}
              done={mushaf.processed_page_count}
              total={mushaf.logical_page_count}
              tone="plain"
            />
            <BandBar
              label={t("details.rail_reviewed")}
              done={mushaf.reviewed_page_count}
              total={mushaf.logical_page_count}
              tone="gold"
            />
          </div>

          <div className="flex gap-[26px]">
            {[
              [stats?.ayat_found, t("details.rail_ayat")],
              [stats?.lines_cut, t("details.rail_lines")],
              [stats?.exported_pngs, t("details.rail_pngs")],
            ].map(([value, label]) => (
              <div key={String(label)} className="flex flex-col">
                <span className="font-display text-[30px] font-semibold leading-[1.1]">
                  {value === undefined ? "…" : Number(value).toLocaleString()}
                </span>
                <span className="text-[12px] text-on-deep-2">{label}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <Link
              to={STEP_ROUTES[cta.slug]}
              params={{ mushafId: mushaf.id }}
              // Review and Ink are page-addressed: Continue lands on the page meant.
              search={cta.reviewPage ? { page: cta.reviewPage } : undefined}
              className="flex min-w-[200px] flex-col gap-0.5 rounded-lg bg-gold px-[18px] py-2.5 text-on-gold no-underline transition-colors hover:bg-gold/90"
            >
              <span className="inline-flex items-center gap-1.5 text-[16px] font-bold">
                {t("header.continue")}
                <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
              </span>
              <span className="text-[12.5px] font-medium">{cta.sub}</span>
            </Link>
            <div className="flex gap-1.5">
              {mushaf.pdf_url && (
                <a href={mushaf.pdf_url} target="_blank" rel="noreferrer" className={quiet}>
                  {t("header.openPdf")}
                </a>
              )}
              <a href={coordinatesUrl(mushaf.id)} download className={quiet}>
                {t("header.downloadJson")}
              </a>
            </div>
          </div>
        </div>

        <nav
          aria-label={t("shell.pipeline")}
          className="flex flex-wrap gap-x-[22px] gap-y-2.5 border-t border-on-deep/[0.14] pt-[18px]"
        >
          {PHASES.map((phase) => (
            <div key={phase.key} className="flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-on-deep-2">
                {t(`shell.phase.${phase.key}`)}
              </span>
              {phase.steps.map((slug) => {
                const step = bySlug.get(slug);
                const next = slug === cta.slug;
                const done = !next && step?.state === "done";
                return (
                  <Link
                    key={slug}
                    to={STEP_ROUTES[slug]}
                    params={{ mushafId: mushaf.id }}
                    className={`inline-flex h-[34px] items-center gap-2 rounded-pill pe-3 ps-1.5 text-[13px] text-on-deep no-underline transition-colors ${
                      next
                        ? "bg-on-deep/[0.12] shadow-[inset_0_0_0_1.5px_var(--gold)]"
                        : done
                          ? "bg-on-deep/[0.08] hover:bg-on-deep/[0.12]"
                          : "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--on-deep)_22%,transparent)] hover:bg-on-deep/[0.08]"
                    }`}
                  >
                    <span
                      className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold ${
                        next
                          ? "bg-gold text-on-gold"
                          : done
                            ? "bg-done text-on-done"
                            : "bg-on-deep/[0.14] text-on-deep"
                      }`}
                    >
                      {next ? (
                        <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden="true" />
                      ) : done ? (
                        "✓"
                      ) : (
                        order.indexOf(slug) + 1
                      )}
                    </span>
                    <span className="font-semibold">{t(`header.steps.${slug}`)}</span>
                    {step && (
                      <span className={step.warn ? "text-gold-on-deep" : "text-on-deep-2"}>
                        {step.detail}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
    </section>
  );
}

import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/app/LanguageSwitcher";
import { SatrLockup } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";
import { UserMenu } from "@/components/app/UserMenu";
import {
  coordinatesUrl,
  mushafStatus,
  useStats,
  useCalibrationPages,
  useTemplates,
  type MushafDetail,
} from "@/lib/api";

import { pipelineSteps, STATUS_META, STEP_ROUTES, type StepSlug } from "./details/helpers";

const STEP_SLUGS: StepSlug[] = ["setup", "templates", "process", "review", "finalize", "ink"];

/** Unified top bar for every mushaf page (workspace steps + the details hub):
 * breadcrumb → hub, status pill, a status-aware 6-step nav, and quick actions. */
export function MushafHeader({
  mushaf,
  activeSlug,
  cta,
}: {
  mushaf: MushafDetail;
  /** The current step, or null on the details hub. */
  activeSlug: StepSlug | null;
  /** Continue CTA — shown on the details hub only. */
  cta?: { slug: StepSlug; sub: string; reviewPage?: number };
}) {
  const { t } = useTranslation();
  const { data: templates } = useTemplates(mushaf.id);
  const { data: stats } = useStats(mushaf.id);
  // Without it the sixth step could never show a tick.
  const { data: calibrationPages } = useCalibrationPages(mushaf.id);
  const templatesReady =
    !!templates &&
    ["sura_header", "aya_separator"].every((t) => templates.some((tpl) => tpl.type === t));
  const stepState = new Map(
    pipelineSteps(mushaf, templatesReady, stats, null, calibrationPages).map((s) => [
      s.slug,
      s.state,
    ]),
  );
  const statusKey = mushafStatus(mushaf);
  const status = STATUS_META[statusKey];

  return (
    <header className="flex h-[60px] flex-shrink-0 items-center gap-3 border-b border-rule bg-card px-5">
      <Link to="/" className="flex items-center" title={t("header.allMushafs")}>
        <SatrLockup />
      </Link>
      <span className="text-ink-3">/</span>
      <Link
        to="/mushafs/$mushafId"
        params={{ mushafId: mushaf.id }}
        title={t("header.overview")}
        className={`max-w-[200px] truncate text-[13px] font-medium transition-colors hover:text-lapis-text ${
          activeSlug === null ? "text-lapis-text" : "text-ink"
        }`}
      >
        {mushaf.name}
      </Link>
      <span className="inline-flex items-center gap-1.5 rounded-pill bg-sheet px-2 py-[3px] text-[10.5px] font-semibold text-ink-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.dot }} />
        {t(`status.${statusKey}`)}
      </span>

      <nav className="ms-auto flex items-center gap-0.5">
        {STEP_SLUGS.map((slug, i) => {
          const active = slug === activeSlug;
          const done = !active && stepState.get(slug) === "done";
          return (
            <Link
              key={slug}
              to={STEP_ROUTES[slug]}
              params={{ mushafId: mushaf.id }}
              className={`flex items-center gap-2 rounded-pill px-2.5 py-1.5 transition-colors hover:bg-sheet ${
                active ? "bg-sheet" : ""
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold leading-none ${
                  active
                    ? "bg-lapis text-on-lapis ring-3 ring-lapis/15"
                    : done
                      ? "bg-done text-on-done"
                      : "border-2 border-rule-2 text-ink-3"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[12px] ${
                  active ? "font-semibold text-lapis-text" : "font-medium text-ink-2"
                }`}
              >
                {t(`header.steps.${slug}`)}
              </span>
            </Link>
          );
        })}
      </nav>

      {cta && (
        <Link
          to={STEP_ROUTES[cta.slug]}
          params={{ mushafId: mushaf.id }}
          // Both page-addressed steps carry it now: review, and the word cuts.
          search={cta.reviewPage ? { page: cta.reviewPage } : undefined}
          className="flex h-12 flex-col p-6 cursor-pointer justify-center rounded-[7px] bg-lapis px-3 text-on-lapis transition-colors hover:bg-lapis/90"
        >
          <span className="text-[15px] font-bold leading-[1.1]">{t("header.continue")}</span>
          <span className="mt-px text-[11px] leading-[1.1] opacity-80">{cta.sub}</span>
        </Link>
      )}
      {mushaf.pdf_url && (
        <a
          href={mushaf.pdf_url}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center rounded-[7px] border border-rule-2 px-2.5 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-sheet"
        >
          {t("header.openPdf")}
        </a>
      )}
      <a
        href={coordinatesUrl(mushaf.id)}
        download
        className="flex h-8 items-center rounded-[7px] border border-rule-2 px-2.5 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-sheet"
      >
        {t("header.downloadJson")}
      </a>
      <Link
        to="/gallery"
        className="flex h-8 items-center rounded-[7px] px-2 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-sheet hover:text-lapis-text"
      >
        {t("gallery.navLink")}
      </Link>
      <ThemeButton />
      <LanguageSwitcher />
      <UserMenu />
    </header>
  );
}

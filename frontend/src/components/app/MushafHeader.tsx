import { Link } from "@tanstack/react-router";

import { coordinatesUrl, mushafStatus, useStats, useTemplates, type MushafDetail } from "@/lib/api";

import { pipelineSteps, STATUS_META, STEP_ROUTES, type StepSlug } from "./details/helpers";

const STEPS: { slug: StepSlug; label: string }[] = [
  { slug: "setup", label: "Setup" },
  { slug: "templates", label: "Templates" },
  { slug: "process", label: "Process" },
  { slug: "review", label: "Review" },
  { slug: "finalize", label: "Finalize" },
];

/** Unified top bar for every mushaf page (workspace steps + the details hub):
 * breadcrumb → hub, status pill, a status-aware 5-step nav, and quick actions. */
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
  const { data: templates } = useTemplates(mushaf.id);
  const { data: stats } = useStats(mushaf.id);
  const templatesReady =
    !!templates &&
    ["sura_header", "aya_separator"].every((t) => templates.some((tpl) => tpl.type === t));
  const stepState = new Map(
    pipelineSteps(mushaf, templatesReady, stats, null).map((s) => [s.slug, s.state]),
  );
  const status = STATUS_META[mushafStatus(mushaf)];

  return (
    <header className="flex h-[60px] flex-shrink-0 items-center gap-3 border-b border-border bg-white px-5">
      <Link to="/" className="flex items-center gap-2.5" title="All mushafs">
        <span className="mt-px h-2 w-2 rounded-[2px] bg-orange" />
        <span className="font-display text-[15px] font-bold leading-none text-navy">
          Quran Page Splitter
        </span>
      </Link>
      <span className="text-text-muted">/</span>
      <Link
        to="/mushafs/$mushafId"
        params={{ mushafId: mushaf.id }}
        title="Mushaf overview"
        className={`max-w-[200px] truncate text-[13px] font-medium transition-colors hover:text-orange ${
          activeSlug === null ? "text-orange" : "text-text-primary"
        }`}
      >
        {mushaf.name}
      </Link>
      <span className="inline-flex items-center gap-1.5 rounded-pill bg-bg-surface px-2 py-[3px] text-[10.5px] font-semibold text-text-secondary">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.dot }} />
        {status.label}
      </span>

      <nav className="ml-auto flex items-center gap-0.5">
        {STEPS.map((s, i) => {
          const active = s.slug === activeSlug;
          const done = !active && stepState.get(s.slug) === "done";
          return (
            <Link
              key={s.slug}
              to={STEP_ROUTES[s.slug]}
              params={{ mushafId: mushaf.id }}
              className={`flex items-center gap-2 rounded-pill px-2.5 py-1.5 transition-colors hover:bg-bg-surface ${
                active ? "bg-bg-surface" : ""
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold leading-none ${
                  active
                    ? "bg-orange text-white shadow-[0_0_0_3px_var(--orange-glow)]"
                    : done
                      ? "bg-success text-white"
                      : "border-2 border-border-strong text-text-muted"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[12px] ${
                  active ? "font-semibold text-orange" : "font-medium text-text-secondary"
                }`}
              >
                {s.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {cta && (
        <Link
          to={STEP_ROUTES[cta.slug]}
          params={{ mushafId: mushaf.id }}
          search={cta.slug === "review" && cta.reviewPage ? { page: cta.reviewPage } : undefined}
          className="flex h-12 flex-col p-6 cursor-pointer justify-center rounded-[7px] bg-orange px-3 text-white transition-colors hover:bg-orange-hover"
        >
          <span className="text-[15px] font-bold leading-[1.1]">Continue →</span>
          <span className="mt-px text-[11px] leading-[1.1] opacity-80">{cta.sub}</span>
        </Link>
      )}
      {mushaf.pdf_url && (
        <a
          href={mushaf.pdf_url}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center rounded-[7px] border border-border-strong px-2.5 text-[11.5px] font-semibold text-text-secondary transition-colors hover:bg-bg-surface"
        >
          PDF ↗
        </a>
      )}
      <a
        href={coordinatesUrl(mushaf.id)}
        download
        className="flex h-8 items-center rounded-[7px] border border-border-strong px-2.5 text-[11.5px] font-semibold text-text-secondary transition-colors hover:bg-bg-surface"
      >
        JSON ↓
      </a>
    </header>
  );
}

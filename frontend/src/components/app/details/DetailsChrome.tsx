import { Link } from "@tanstack/react-router";

import { coordinatesUrl, mushafStatus, type MushafDetail } from "@/lib/api";

import { fmtDayTime, STATUS_META, STEP_ROUTES, type StepSlug } from "./helpers";

/** Navy top bar: breadcrumb · status pill · updated · Continue CTA · PDF/JSON. */
export function DetailsChrome({
  mushaf,
  cta,
}: {
  mushaf: MushafDetail;
  cta: { slug: StepSlug; sub: string; reviewPage?: number };
}) {
  const status = STATUS_META[mushafStatus(mushaf)];
  return (
    <div className="flex h-[50px] flex-shrink-0 items-center gap-2.5 bg-navy px-4 text-white">
      <Link to="/" className="flex items-center gap-2.5" title="All mushafs">
        <span className="h-2 w-2 rounded-[2px] bg-orange" />
        <span className="font-display text-[13.5px] font-extrabold tracking-[-0.01em]">
          Quran Page Splitter
        </span>
      </Link>
      <span className="opacity-45">/</span>
      <Link to="/" className="text-[12px] text-white/60 transition-colors hover:text-white">
        Mushafs
      </Link>
      <span className="opacity-45">/</span>
      <span className="max-w-[220px] truncate text-[12.5px] font-semibold">{mushaf.name}</span>
      <span className="ml-0.5 inline-flex items-center gap-1.5 rounded-pill bg-white/13 px-2.5 py-[3px] text-[10.5px] font-semibold">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.dot }} />
        {status.label}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <span className="mr-0.5 text-[10.5px] text-white/50">
          Updated {fmtDayTime(mushaf.updated_at)}
        </span>
        <Link
          to={STEP_ROUTES[cta.slug]}
          params={{ mushafId: mushaf.id }}
          search={cta.slug === "review" && cta.reviewPage ? { page: cta.reviewPage } : undefined}
          className="flex h-8 flex-col justify-center rounded-[7px] bg-orange px-3 text-white transition-colors hover:bg-orange-hover"
        >
          <span className="text-[11.5px] font-bold leading-[1.05]">Continue →</span>
          <span className="mt-px text-[9px] leading-[1.05] opacity-80">{cta.sub}</span>
        </Link>
        {mushaf.pdf_url && (
          <a
            href={mushaf.pdf_url}
            target="_blank"
            rel="noreferrer"
            className="flex h-8 items-center rounded-[7px] border border-white/25 px-2.5 text-[11.5px] font-semibold transition-colors hover:bg-white/10"
          >
            PDF ↗
          </a>
        )}
        <a
          href={coordinatesUrl(mushaf.id)}
          download
          className="flex h-8 items-center rounded-[7px] border border-white/25 px-2.5 text-[11.5px] font-semibold transition-colors hover:bg-white/10"
        >
          JSON ↓
        </a>
      </div>
    </div>
  );
}

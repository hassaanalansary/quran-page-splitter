import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AbortInfo } from "@/lib/api";
import { mediaUrl } from "@/lib/api/http";

/** Detection evidence for an aborted run: every line it found on the page, each
 * as its debug crop with its position and height (the key "why did it mis-split"
 * signal), then the header match scores, the text regions and the full log. */
export function AbortDiagnostics({ info, logUrl }: { info: AbortInfo; logUrl?: string | null }) {
  const { t } = useTranslation();
  const d = info.diagnostics;
  const lines = d?.lines ?? [];
  const headers = d?.headers ?? [];
  const regions = d?.text_regions ?? [];
  const imageUrls = (info.debug_images ?? []).map(mediaUrl);

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {t("canvas.diag_detectedLines", { count: lines.length })}
        </h3>
        <span className="text-[12px] text-ink-3">
          {t("canvas.diag_counts", { headers: headers.length, regions: regions.length })}
        </span>
      </div>

      {lines.length === 0 ? (
        <p className="m-0 text-[12.5px] text-ink-3">{t("canvas.diag_noLines")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 rounded-card bg-well p-2.5">
          {lines.map((ln, i) => (
            <li key={ln.index} className="flex items-center gap-2.5">
              <span className="w-[22px] flex-none text-end font-mono text-[11px] text-ink-4">
                {ln.index}
              </span>
              {/* The crop stays on the page colour: it is a piece of the scan. */}
              <span className="flex min-h-5 min-w-0 flex-1 items-center rounded-[3px] bg-page px-2 py-0.5">
                {imageUrls[i] ? (
                  <a href={imageUrls[i]} target="_blank" rel="noreferrer" className="block w-full">
                    <img
                      src={imageUrls[i]}
                      alt={t("canvas.diag_lineAlt", { index: ln.index })}
                      className="block max-h-10 w-full object-contain"
                    />
                  </a>
                ) : (
                  <span className="text-[10.5px] text-ink-4">{t("canvas.diag_noImage")}</span>
                )}
              </span>
              <span
                dir="ltr"
                className={`w-[132px] flex-none font-mono text-[11px] ${ln.is_sura ? "text-gold-text" : "text-ink-4"}`}
              >
                {t("canvas.diag_region", { y: ln.y, h: ln.h })}
                {ln.is_sura ? ` · ${t("canvas.diag_header")}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}

      {headers.length > 0 && (
        <Details title={t("canvas.diag_suraHeaders", { count: headers.length })}>
          {headers.map((h, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span>{t("canvas.diag_slots", { y: h.y, h: h.h, slots: h.slots })}</span>
              <span className="font-semibold text-ink">
                {t("canvas.diag_score", { score: h.score.toFixed(3) })}
              </span>
            </li>
          ))}
        </Details>
      )}

      {regions.length > 0 && (
        <Details title={t("canvas.diag_textRegions", { count: regions.length })}>
          {regions.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span>{t("canvas.diag_region", { y: r.y, h: r.h })}</span>
              <span className="font-semibold text-ink">
                {t("canvas.diag_expects", { count: r.expected_lines })}
              </span>
            </li>
          ))}
        </Details>
      )}

      {logUrl && (
        <a
          href={logUrl}
          target="_blank"
          rel="noreferrer"
          className="self-start text-[13px] font-semibold text-lapis-text no-underline hover:underline"
        >
          {t("canvas.diag_downloadLog")}
        </a>
      )}
    </section>
  );
}

function Details({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-rule-soft bg-sheet">
      <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {title}
      </summary>
      <ul
        dir="ltr"
        className="m-0 flex list-none flex-col gap-1 border-t border-rule-soft px-3 py-2 font-mono text-[11.5px] text-ink-2"
      >
        {children}
      </ul>
    </details>
  );
}

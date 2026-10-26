import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { AbortInfo } from "@/lib/api";
import { mediaUrl } from "@/lib/api/http";

/** Detection diagnostics for an aborted run — pairs each detected line with its
 * debug image (the key "why did it mis-split" signal), plus header match scores,
 * text regions, and a link to the full log. Collapsible so it stays tidy. */
export function AbortDiagnostics({ info, logUrl }: { info: AbortInfo; logUrl?: string | null }) {
  const { t } = useTranslation();
  const d = info.diagnostics;
  const lines = d?.lines ?? [];
  const headers = d?.headers ?? [];
  const regions = d?.text_regions ?? [];
  const images = info.debug_images ?? [];
  const imageUrls = images.map(mediaUrl);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] leading-[1.55] text-ink-2">
        {t("canvas.diag_intro", {
          expected: info.expected_lines ?? "?",
          detected: info.detected_slots ?? info.detected_lines ?? "?",
          lines: lines.length,
        })}
      </p>

      <Section title={t("canvas.diag_detectedLines", { count: lines.length })} defaultOpen>
        {lines.length === 0 ? (
          <p className="text-[11px] text-ink-3">{t("canvas.diag_noLines")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {lines.map((ln, i) => (
              <figure key={ln.index} className="rounded-[6px] border border-rule bg-card p-1">
                {imageUrls[i] ? (
                  <a href={imageUrls[i]} target="_blank" rel="noreferrer">
                    <img
                      src={imageUrls[i]}
                      alt={t("canvas.diag_lineAlt", { index: ln.index })}
                      className="h-auto w-full rounded-[3px] border border-sheet bg-white object-contain"
                    />
                  </a>
                ) : (
                  <div className="flex h-7 items-center justify-center text-[9.5px] text-ink-3">
                    {t("canvas.diag_noImage")}
                  </div>
                )}
                <figcaption className="mt-1 flex items-center justify-between px-0.5 font-mono text-[9.5px] text-ink-2">
                  <span className={ln.is_sura ? "font-bold text-lapis-text" : ""}>
                    L{ln.index}
                    {ln.is_sura ? " · hdr" : ""}
                  </span>
                  <span>{ln.h}px</span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Section>

      {headers.length > 0 && (
        <Section title={t("canvas.diag_suraHeaders", { count: headers.length })}>
          <ul className="flex flex-col gap-1 font-mono text-[10.5px] text-ink-2">
            {headers.map((h, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>{t("canvas.diag_slots", { y: h.y, h: h.h, slots: h.slots })}</span>
                <span className="font-bold text-ink">
                  {t("canvas.diag_score", { score: h.score.toFixed(3) })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {regions.length > 0 && (
        <Section title={t("canvas.diag_textRegions", { count: regions.length })}>
          <ul className="flex flex-col gap-1 font-mono text-[10.5px] text-ink-2">
            {regions.map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>{t("canvas.diag_region", { y: r.y, h: r.h })}</span>
                <span className="font-bold text-ink">
                  {t("canvas.diag_expects", { count: r.expected_lines })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {logUrl && (
        <a
          href={logUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-block text-[11px] font-semibold text-lapis-text hover:text-lapis-text/80"
        >
          {t("canvas.diag_downloadLog")}
        </a>
      )}
    </div>
  );
}

function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="rounded-[7px] border border-rule bg-sheet">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {title}
      </summary>
      <div className="border-t border-rule bg-card px-2.5 py-2">{children}</div>
    </details>
  );
}

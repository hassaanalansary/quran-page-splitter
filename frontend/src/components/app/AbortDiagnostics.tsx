import type { ReactNode } from "react";

import type { AbortInfo } from "@/lib/api";
import { mediaUrl } from "@/lib/api/http";

/** Detection diagnostics for an aborted run — pairs each detected line with its
 * debug image (the key "why did it mis-split" signal), plus header match scores,
 * text regions, and a link to the full log. Collapsible so it stays tidy. */
export function AbortDiagnostics({ info, logUrl }: { info: AbortInfo; logUrl?: string | null }) {
  const d = info.diagnostics;
  const lines = d?.lines ?? [];
  const headers = d?.headers ?? [];
  const regions = d?.text_regions ?? [];
  const images = info.debug_images ?? [];
  const imageUrls = images.map(mediaUrl);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11.5px] leading-[1.55] text-text-secondary">
        Expected <b className="text-text-primary">{info.expected_lines ?? "?"}</b> line slots; the
        detector found{" "}
        <b className="text-text-primary">{info.detected_slots ?? info.detected_lines ?? "?"}</b>{" "}
        across <b className="text-text-primary">{lines.length}</b> line
        {lines.length === 1 ? "" : "s"}. Scan the detected lines for a merge or split, then tune the
        bounds, expected-lines, or header threshold.
      </p>

      <Section title={`Detected lines · ${lines.length}`} defaultOpen>
        {lines.length === 0 ? (
          <p className="text-[11px] text-text-muted">
            No lines were detected — check the crop bounds and the page image.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {lines.map((ln, i) => (
              <figure key={ln.index} className="rounded-[6px] border border-border bg-white p-1">
                {imageUrls[i] ? (
                  <a href={imageUrls[i]} target="_blank" rel="noreferrer">
                    <img
                      src={imageUrls[i]}
                      alt={`detected line ${ln.index}`}
                      className="h-auto w-full rounded-[3px] border border-bg-surface bg-white object-contain"
                    />
                  </a>
                ) : (
                  <div className="flex h-7 items-center justify-center text-[9.5px] text-text-muted">
                    no image
                  </div>
                )}
                <figcaption className="mt-1 flex items-center justify-between px-0.5 font-mono text-[9.5px] text-text-secondary">
                  <span className={ln.is_sura ? "font-bold text-navy" : ""}>
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
        <Section title={`Sura headers · ${headers.length}`}>
          <ul className="flex flex-col gap-1 font-mono text-[10.5px] text-text-secondary">
            {headers.map((h, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>
                  y={h.y} · {h.h}px · {h.slots} slot{h.slots === 1 ? "" : "s"}
                </span>
                <span className="font-bold text-text-primary">score {h.score.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {regions.length > 0 && (
        <Section title={`Text regions · ${regions.length}`}>
          <ul className="flex flex-col gap-1 font-mono text-[10.5px] text-text-secondary">
            {regions.map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <span>
                  y={r.y} · {r.h}px
                </span>
                <span className="font-bold text-text-primary">
                  expects {r.expected_lines} line{r.expected_lines === 1 ? "" : "s"}
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
          className="mt-0.5 inline-block text-[11px] font-semibold text-orange hover:text-orange-hover"
        >
          Download detection log ↓
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
    <details open={defaultOpen} className="rounded-[7px] border border-border bg-bg-surface">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {title}
      </summary>
      <div className="border-t border-border bg-white px-2.5 py-2">{children}</div>
    </details>
  );
}

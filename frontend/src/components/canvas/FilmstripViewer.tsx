import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CroppableImage } from "@/components/canvas/CroppableImage";
import { PagePill } from "@/components/canvas/PagePill";
import { pageImageUrl } from "@/lib/api";
import type { Rect } from "@/lib/api/types";

type Props = {
  mushafId: string;
  /** Logical page count. */
  pageCount: number;
  /** Current logical page (1-based, controlled). */
  page: number;
  onPageChange: (n: number) => void;
  /** Cache-bust token for rendered pages (e.g. mushaf.updated_at). */
  version?: string | number;
  /** Secondary label for the page pill, e.g. the physical PDF page. */
  renderLabel?: (logical: number) => string;
  /** A short note at the start of the toolbar. */
  hint?: string;
  /** A badge over the current page ("First Quran page"), or null for none. */
  badge?: (logical: number) => string | null;
  /** The strip under the stage: the pages marked as the range so far (logical,
   * inclusive), and the labels at its ends and middle. */
  scrub?: {
    range: [number, number] | null;
    marks: number[];
    startLabel: string;
    endLabel: string;
    summary: string;
  };
  /** Enables a draggable crop rectangle on the current (centred) page. */
  crop?: {
    label: string;
    rect: Rect | null;
    onRectChange: (r: Rect | null) => void;
  };
};

const GAP = 36; // gap (px) between adjacent page slots
const WINDOW = 3; // render slots within ± this of the current page
const IMG = 2; // render real page images within ± this (prefetch); rest are placeholders
const DEFAULT_ASPECT = 0.707; // A4 portrait until a real page loads

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** How many cells the scrubber draws at most; past that, a cell is a run of pages. */
const SCRUB_CELLS = 120;

/**
 * Desktop-style page browser. Layout is pure CSS (slots centred via translateX
 * percentages — no measurement), so only a small window of slots renders.
 * Adjacent moves slide the surviving slots; far jumps "whoosh" the new window in
 * from the travel direction. The toolbar above holds the page pill; the scrubber
 * below is the whole book in at most 120 cells, the range marked so far shaded.
 */
export function FilmstripViewer({
  mushafId,
  pageCount,
  page,
  onPageChange,
  version,
  renderLabel,
  hint,
  badge,
  scrub,
  crop,
}: Props) {
  const prevPageRef = useRef(page);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [whoosh, setWhoosh] = useState({ pct: 0, anim: false });

  // Whoosh the new window in when jumping past the rendered window.
  useLayoutEffect(() => {
    const prev = prevPageRef.current;
    prevPageRef.current = page;
    if (prev === page) return;
    const delta = page - prev;
    if (Math.abs(delta) > WINDOW) {
      setWhoosh({ pct: Math.sign(delta) * 60, anim: false });
      const id = requestAnimationFrame(() => setWhoosh({ pct: 0, anim: true }));
      return () => cancelAnimationFrame(id);
    }
  }, [page]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") onPageChange(clamp(page - 1, 1, pageCount));
    else if (e.key === "ArrowRight") onPageChange(clamp(page + 1, 1, pageCount));
    else if (e.key === "Home") onPageChange(1);
    else if (e.key === "End") onPageChange(pageCount);
    else return;
    e.preventDefault();
  }

  const lo = clamp(page - WINDOW, 1, pageCount);
  const hi = clamp(page + WINDOW, 1, pageCount);
  const slots: number[] = [];
  for (let p = lo; p <= hi; p++) slots.push(p);

  const currentBadge = badge?.(page) ?? null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-well">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2.5 px-4 py-3">
        {hint ? (
          <span className="rounded-lg border border-rule bg-sheet px-3 py-1.5 text-[13px] text-ink-2">
            {hint}
          </span>
        ) : (
          <span />
        )}
        <PagePill
          page={page}
          pageCount={pageCount}
          onPageChange={onPageChange}
          label={renderLabel?.(page)}
        />
      </div>

      {/* Stage */}
      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="canvas-well relative flex-1 overflow-hidden outline-none"
      >
        <div
          className="absolute inset-0"
          style={{
            transform: `translateX(${whoosh.pct}%)`,
            transition: whoosh.anim ? "transform 340ms ease-out" : "none",
          }}
        >
          {slots.map((p) => {
            const dp = p - page;
            const isCurrent = dp === 0;
            const withImage = Math.abs(dp) <= IMG;
            const slotStyle: React.CSSProperties = {
              top: 28,
              bottom: 28,
              aspectRatio: String(aspect),
              // RTL like a mushaf/Arabic book: higher page numbers sit to the LEFT.
              transform: `translateX(calc(-50% + ${-dp * 100}% + ${-dp * GAP}px))`,
              transition: "transform 440ms cubic-bezier(0.22,0.61,0.36,1)",
              borderColor: isCurrent ? "var(--lapis)" : "var(--rule)",
              boxShadow: isCurrent ? "var(--shadow-lift)" : "var(--shadow-card)",
              opacity: isCurrent ? 1 : 0.5,
              zIndex: isCurrent ? 2 : 1,
            };

            // The current page is the crop surface (a div, not a nav button).
            if (crop && isCurrent) {
              return (
                <div
                  key={p}
                  className="absolute left-1/2 overflow-hidden rounded-[4px] border bg-white"
                  style={slotStyle}
                >
                  <CroppableImage
                    imageUrl={pageImageUrl(mushafId, p, version)}
                    rect={crop.rect}
                    onRectChange={crop.onRectChange}
                    label={crop.label}
                    onNatural={(n) => {
                      const a = n.w / n.h;
                      setAspect((prev) => (Math.abs(prev - a) > 0.01 ? a : prev));
                    }}
                  />
                </div>
              );
            }

            return (
              <button
                key={p}
                type="button"
                onClick={() => p !== page && onPageChange(p)}
                aria-current={isCurrent ? "page" : undefined}
                tabIndex={-1}
                className="absolute left-1/2 overflow-hidden rounded-[4px] border bg-white"
                style={{ ...slotStyle, cursor: isCurrent ? "default" : "pointer" }}
              >
                {withImage ? (
                  <img
                    src={pageImageUrl(mushafId, p, version)}
                    alt={`Page ${p}`}
                    draggable={false}
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      if (el.naturalWidth > 0) {
                        const a = el.naturalWidth / el.naturalHeight;
                        setAspect((prev) => (Math.abs(prev - a) > 0.01 ? a : prev));
                      }
                    }}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-sheet">
                    <span className="font-display text-3xl font-bold text-ink-3/60">{p}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
        {currentBadge && (
          <span className="pointer-events-none absolute left-1/2 top-3.5 z-[3] -translate-x-1/2 whitespace-nowrap rounded-pill bg-gold px-3 py-[5px] text-[12.5px] font-bold text-on-gold shadow-[0_4px_10px_rgba(0,0,0,0.18)]">
            {currentBadge}
          </span>
        )}
      </div>

      {scrub && (
        <Scrubber page={page} pageCount={pageCount} onPageChange={onPageChange} scrub={scrub} />
      )}
    </div>
  );
}

/** The whole book as a strip of cells in mushaf order (first page on the right):
 * the range marked so far shaded, its ends ringed, the current page gold. A cell
 * opens the first page it covers. */
function Scrubber({
  page,
  pageCount,
  onPageChange,
  scrub,
}: {
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  scrub: NonNullable<Props["scrub"]>;
}) {
  const cells = Math.min(pageCount, SCRUB_CELLS);
  const startOf = (i: number) => Math.floor((i * pageCount) / cells) + 1;
  const endOf = (i: number) => Math.floor(((i + 1) * pageCount) / cells);
  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-t border-rule bg-sheet px-5 pb-3.5 pt-3">
      <div dir="rtl" className="flex justify-between gap-3 font-mono text-[12px] text-ink-3">
        <span>{scrub.startLabel}</span>
        <span className="font-sans text-ink-2" dir="auto">
          {scrub.summary}
        </span>
        <span>{scrub.endLabel}</span>
      </div>
      <div dir="rtl" className="flex h-7 gap-[2px]">
        {Array.from({ length: cells }, (_, i) => {
          const from = startOf(i);
          const to = endOf(i);
          const current = page >= from && page <= to;
          const marked = scrub.marks.some((m) => m >= from && m <= to);
          const inRange = !!scrub.range && to >= scrub.range[0] && from <= scrub.range[1];
          return (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              onClick={() => onPageChange(from)}
              title={from === to ? String(from) : `${from}–${to}`}
              className={`min-w-0 flex-1 cursor-pointer rounded-[2px] ${
                current ? "bg-gold" : inRange ? "bg-lapis-wash" : "bg-sunk"
              } ${marked ? "shadow-[inset_0_0_0_2px_var(--lapis)]" : ""} hover:opacity-80`}
            />
          );
        })}
      </div>
    </div>
  );
}

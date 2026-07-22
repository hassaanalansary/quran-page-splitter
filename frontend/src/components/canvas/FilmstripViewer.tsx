import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CroppableImage } from "@/components/canvas/CroppableImage";
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
  /** Secondary label for the footer, e.g. the physical PDF page. */
  renderLabel?: (logical: number) => string;
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

/** Page numbers to show in the compact pager rail (first, …, current±3, …, last). */
function pagerItems(current: number, total: number): (number | "gap")[] {
  const wanted = new Set<number>([1, total]);
  for (let i = current - 3; i <= current + 3; i++) if (i >= 1 && i <= total) wanted.add(i);
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("gap");
    out.push(n);
  });
  return out;
}

/**
 * Desktop-style page browser. Layout is pure CSS (slots centred via translateX
 * percentages — no measurement), so only a small window of slots renders.
 * Adjacent moves slide the surviving slots; far jumps "whoosh" the new window in
 * from the travel direction. The rail is a compact pager, not 600 chips.
 */
export function FilmstripViewer({
  mushafId,
  pageCount,
  page,
  onPageChange,
  version,
  renderLabel,
  crop,
}: Props) {
  const { t, i18n } = useTranslation();
  const prevPageRef = useRef(page);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [jumping, setJumping] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [whoosh, setWhoosh] = useState({ pct: 0, anim: false });

  const isRTL = i18n.dir() === "rtl";

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
    if (jumping) return;
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

  function commitJump() {
    const n = clamp(Math.round(Number(jumpValue) || page), 1, pageCount);
    onPageChange(n);
    setJumping(false);
    setJumpValue("");
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Stage */}
      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="raqam-canvas-grid relative flex-1 overflow-hidden outline-none"
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
              borderColor: isCurrent ? "var(--orange)" : "var(--border)",
              boxShadow: isCurrent ? "var(--shadow-page)" : "var(--shadow-sm)",
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
                  <div className="flex h-full w-full items-center justify-center bg-bg-surface">
                    <span className="font-display text-3xl font-bold text-text-muted/60">{p}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* RTL: the left arrow advances (next page is to the left), the right goes back. */}
        <ChevronButton
          side="left"
          disabled={page >= pageCount}
          onClick={() => onPageChange(clamp(page + 1, 1, pageCount))}
        />
        <ChevronButton
          side="right"
          disabled={page <= 1}
          onClick={() => onPageChange(clamp(page - 1, 1, pageCount))}
        />

        {/* Footer overlay: page indicator + jump */}
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-pill border border-border bg-white/90 px-3 py-1.5 shadow-[var(--shadow-sm)] backdrop-blur">
          {jumping ? (
            <input
              autoFocus
              type="number"
              min={1}
              max={pageCount}
              value={jumpValue}
              placeholder={String(page)}
              onChange={(e) => setJumpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitJump();
                else if (e.key === "Escape") {
                  setJumping(false);
                  setJumpValue("");
                }
              }}
              onBlur={commitJump}
              className="h-6 w-16 rounded border border-border-strong px-2 text-center text-[13px] tabular-nums outline-none focus:border-orange"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setJumpValue("");
                setJumping(true);
              }}
              className="text-[13px] font-semibold tabular-nums text-text-primary hover:text-orange"
              title={t("canvas.jumpTitle")}
            >
              {t("canvas.pageJump", { page })}
            </button>
          )}
          <span className="text-[12px] text-text-muted">/ {pageCount}</span>
          {renderLabel && (
            <span className="border-s border-border ps-3 text-[12px] text-text-secondary">
              {renderLabel(page)}
            </span>
          )}
        </div>
      </div>

      {/* Compact pager rail */}
      <div
        className={`flex h-11 flex-shrink-0 items-center justify-center gap-1 border-t border-border bg-white px-3 ${isRTL ? "flex-row" : "flex-row-reverse"}`}
      >
        {pagerItems(page, pageCount).map((item, i) =>
          item === "gap" ? (
            <button
              key={`gap-${i}`}
              type="button"
              onClick={() => {
                setJumpValue("");
                setJumping(true);
              }}
              title={t("canvas.jumpToPage")}
              className="px-1 text-[12px] text-text-muted hover:text-orange"
            >
              …
            </button>
          ) : (
            <button
              key={item}
              type="button"
              onClick={() => onPageChange(item)}
              className={[
                "h-7 min-w-7 rounded px-2 text-[12px] font-medium tabular-nums transition-colors",
                item === page
                  ? "bg-orange text-white"
                  : "bg-bg-surface text-text-secondary hover:bg-bg-muted hover:text-text-primary",
              ].join(" ")}
            >
              {item}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function ChevronButton({
  side,
  onClick,
  disabled,
}: {
  side: "left" | "right";
  onClick: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? t("canvas.prevPage") : t("canvas.nextPage")}
      className={[
        "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-white/90 text-text-secondary shadow-[var(--shadow-md)] backdrop-blur transition hover:text-orange disabled:cursor-not-allowed disabled:opacity-30",
        side === "left" ? "left-3" : "right-3",
      ].join(" ")}
    >
      {side === "left" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  );
}

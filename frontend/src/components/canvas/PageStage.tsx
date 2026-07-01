import { useEffect, useState, type ReactNode } from "react";

import { ChevronNav } from "@/components/canvas/ChevronNav";
import { PageCanvas } from "@/components/canvas/PageCanvas";
import { PageJump } from "@/components/canvas/PageJump";
import { PageRail } from "@/components/canvas/PageRail";
import { ToolToggle } from "@/components/canvas/ToolToggle";
import { ZoomControl, type Zoom } from "@/components/canvas/ZoomControl";
import { useSpaceHeld, type CanvasTool } from "@/hooks/use-space-pan";
import type { Rect } from "@/lib/api/types";

type Props = {
  imageUrl: string | null;
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  /** Secondary footer label, e.g. the physical PDF page. */
  renderLabel?: (page: number) => string;
  /** Enables a draggable/zoomable crop rectangle. */
  crop?: {
    label: string;
    rect: Rect | null;
    onRectChange: (r: Rect | null) => void;
  };
  /** Reports the page image's natural size once loaded. */
  onNatural?: (n: { w: number; h: number }) => void;
  /** Extra toolbar controls (e.g. Capture / Clear). */
  toolbarExtras?: ReactNode;
  /** Page-rail indicators (processed / reviewed logical pages). */
  processed?: Set<number>;
  reviewed?: Set<number>;
};

/**
 * A single zoomable/pannable page with select & hand tools, chevron prev/next,
 * a click-to-jump page indicator, and an optional crop rectangle. The building
 * blocks (ChevronNav, PageJump, ZoomControl, ToolToggle, PageCanvas) are all
 * standalone and reused elsewhere.
 */
export function PageStage({
  imageUrl,
  page,
  pageCount,
  onPageChange,
  renderLabel,
  crop,
  onNatural,
  toolbarExtras,
  processed,
  reviewed,
}: Props) {
  const [zoom, setZoom] = useState<Zoom>(-1);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const spaceHeld = useSpaceHeld();
  const effectiveTool: CanvasTool = tool === "hand" || spaceHeld ? "hand" : "select";
  const cropping = !!crop;

  // Desktop shortcuts: V = select, H = hand, ←/→ = prev/next page.
  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "h" || e.key === "H") setTool("hand");
      else if (e.key === "ArrowLeft") onPageChange(Math.max(1, page - 1));
      else if (e.key === "ArrowRight") onPageChange(Math.min(pageCount, page + 1));
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, pageCount, onPageChange]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3">
        <ToolToggle value={effectiveTool} onChange={setTool} />
        {toolbarExtras && (
          <>
            <div className="mx-1 h-5 w-px bg-border" />
            {toolbarExtras}
          </>
        )}
        <div className="ml-auto">
          <ZoomControl value={zoom} onChange={setZoom} />
        </div>
      </div>

      {/* Canvas + chevrons + floating page indicator */}
      <div className="relative flex flex-1 overflow-hidden">
        <PageCanvas
          imageUrl={imageUrl}
          zoom={zoom}
          onZoomChange={setZoom}
          drawing={cropping}
          label={cropping ? crop.label : null}
          rect={cropping ? crop.rect : null}
          onRectChange={crop?.onRectChange ?? (() => {})}
          onCursorChange={setCursor}
          onNatural={onNatural}
          tool={tool}
        />
        <ChevronNav page={page} pageCount={pageCount} onPageChange={onPageChange} />
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-pill border border-border bg-white/90 px-3 py-1.5 shadow-[var(--shadow-sm)] backdrop-blur">
          <PageJump
            page={page}
            pageCount={pageCount}
            onPageChange={onPageChange}
            label={renderLabel?.(page)}
          />
        </div>
      </div>

      {/* Status bar: live cursor + crop dimensions */}
      <div className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-border bg-white px-3 text-[12px] text-text-muted">
        <span className="font-mono">
          {cursor ? `x: ${cursor.x}  y: ${cursor.y}` : "x: —  y: —"}
        </span>
        {cropping && (
          <span className="ml-auto font-medium text-orange">
            ●{" "}
            {crop.rect
              ? `${Math.round(crop.rect.w)} × ${Math.round(crop.rect.h)} px`
              : `Draw: ${crop.label}`}
          </span>
        )}
      </div>

      <PageRail
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        processed={processed}
        reviewed={reviewed}
      />
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PageCanvas } from "@/components/canvas/PageCanvas";
import { PagePill } from "@/components/canvas/PagePill";
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
    /**
     * Show the rect mirrored across the page's vertical centerline as a
     * read-only preview (alternate-margin pages). Editing stays on normal pages.
     */
    mirrored?: boolean;
    /** Freeze the rect — visible, but not draggable or resizable. */
    locked?: boolean;
    /** Draw it as the text-area bounds (see PageCanvas). */
    tone?: "bounds";
  };
  /** Reports the page image's natural size once loaded. */
  onNatural?: (n: { w: number; h: number }) => void;
  /** Extra toolbar controls, after the tools (Process's bounds lock). */
  toolbarExtras?: ReactNode;
  /** Laid over the bottom of the canvas (Process's live log). */
  overlay?: ReactNode;
  /** Page-rail indicators (processed / reviewed logical pages). */
  processed?: Set<number>;
  reviewed?: Set<number>;
};

/**
 * A single zoomable/pannable page with an optional crop rectangle. The toolbar
 * sits on the well above it: select & hand tools, the page pill (next, a
 * click-to-jump page indicator, previous) and zoom. The building blocks (PagePill,
 * ZoomControl, ToolToggle, PageCanvas) are standalone and reused elsewhere.
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
  overlay,
  processed,
  reviewed,
}: Props) {
  const { t, i18n } = useTranslation();
  const [zoom, setZoom] = useState<Zoom>(-1);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const spaceHeld = useSpaceHeld();
  const effectiveTool: CanvasTool = tool === "hand" || spaceHeld ? "hand" : "select";
  const cropping = !!crop;

  const isRTL = i18n.dir() === "rtl";

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
      {/* Toolbar, on the well */}
      <div
        data-tour="canvas-toolbar"
        className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2.5 bg-well px-4 py-3"
      >
        <div className="flex items-center gap-2.5">
          <ToolToggle value={effectiveTool} onChange={setTool} />
          {toolbarExtras}
        </div>
        <PagePill
          page={page}
          pageCount={pageCount}
          onPageChange={onPageChange}
          label={renderLabel?.(page)}
        />
        <ZoomControl value={zoom} onChange={setZoom} />
      </div>

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
          mirrored={cropping ? !!crop.mirrored : false}
          locked={cropping ? !!crop.locked : false}
          tone={crop?.tone}
        />
        {overlay}
      </div>

      {/* Status bar: live cursor + crop dimensions */}
      <div className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-rule bg-sheet px-4 text-[12px] text-ink-3">
        <span className="font-mono">
          {cursor ? `x: ${cursor.x}  y: ${cursor.y}` : "x: —  y: —"}
        </span>
        {cropping && (
          <span
            className="ml-auto font-medium"
            style={{ color: crop.mirrored ? "var(--gold-text)" : "var(--lapis-text)" }}
          >
            ●{" "}
            {crop.rect
              ? `${Math.round(crop.rect.w)} × ${Math.round(crop.rect.h)} px${
                  crop.mirrored
                    ? ` · ${t("canvas.mirroredReadonly")}`
                    : crop.locked
                      ? ` · ${t("canvas.locked")}`
                      : ""
                }`
              : t("canvas.draw", { label: crop.label })}
          </span>
        )}
      </div>

      <PageRail
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        processed={processed}
        reviewed={reviewed}
        isRTL={isRTL}
      />
    </div>
  );
}

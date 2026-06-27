import { useEffect, useState, type ReactNode } from "react";

import { PageCanvas } from "@/components/canvas/PageCanvas";
import { useSpaceHeld, type CanvasTool } from "@/hooks/use-space-pan";
import type { Rect } from "@/lib/api/types";

type Props = {
  imageUrl: string | null;
  emptyHint?: string;
  /** Setting `cropLabel` + `onRectChange` enables the draggable crop rectangle. */
  cropLabel?: string;
  rect?: Rect | null;
  onRectChange?: (r: Rect | null) => void;
  onApply?: () => void;
  applyDisabled?: boolean;
  applyLabel?: string;
  /** Page navigation (Prev/Next); omit to hide. */
  page?: number;
  pageCount?: number;
  onPageChange?: (n: number) => void;
  /** Status-bar text on the left (e.g. "PDF page 3 of 600"). */
  statusText?: string;
  /** Extra controls rendered at the right end of the toolbar. */
  toolbarExtras?: ReactNode;
};

/** Multiplier; -1 = "fit to canvas". */
type Zoom = number;

export function CropStudio({
  imageUrl,
  emptyHint = "No page to display.",
  cropLabel,
  rect = null,
  onRectChange,
  onApply,
  applyDisabled,
  applyLabel = "Apply",
  page,
  pageCount,
  onPageChange,
  statusText,
  toolbarExtras,
}: Props) {
  const cropping = cropLabel != null && onRectChange != null;
  const [zoom, setZoom] = useState<Zoom>(-1);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const spaceHeld = useSpaceHeld();
  const effectiveTool: CanvasTool = tool === "hand" || spaceHeld ? "hand" : "select";

  // Desktop-style shortcuts: V = select, H = hand.
  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "h" || e.key === "H") setTool("hand");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const canPrev = page != null && page > 1;
  const canNext = page != null && pageCount != null && page < pageCount;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3">
        <ToolButton
          active={effectiveTool === "select"}
          onClick={() => setTool("select")}
          title="Select / crop tool (V)"
        >
          <CursorIcon />
        </ToolButton>
        <ToolButton
          active={effectiveTool === "hand"}
          onClick={() => setTool("hand")}
          title="Hand tool — pan (H, or hold Space)"
        >
          <HandIcon />
        </ToolButton>

        {cropping && (
          <>
            <div className="mx-1 h-5 w-px bg-border" />
            <ToolbarButton
              onClick={() => onRectChange?.(null)}
              label="New"
              title="Clear and redraw the crop"
            />
            {onApply && (
              <ToolbarButton
                onClick={onApply}
                disabled={applyDisabled}
                label={applyLabel}
                primary
              />
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {page != null && (
            <>
              <ToolbarButton
                onClick={() => onPageChange?.(page - 1)}
                label="Prev"
                disabled={!canPrev}
              />
              <ToolbarButton
                onClick={() => onPageChange?.(page + 1)}
                label="Next"
                disabled={!canNext}
              />
            </>
          )}
          <ZoomControl value={zoom} onChange={setZoom} />
          {toolbarExtras}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex flex-1 overflow-hidden">
        <PageCanvas
          imageUrl={imageUrl}
          zoom={zoom}
          onZoomChange={setZoom}
          drawing={cropping}
          label={cropping ? (cropLabel ?? null) : null}
          rect={cropping ? rect : null}
          onRectChange={onRectChange ?? (() => {})}
          onCursorChange={setCursor}
          tool={tool}
        />
      </div>

      {/* Status bar */}
      <div className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-border bg-white px-3 text-[12px] text-text-muted">
        <span className="font-medium text-text-secondary">{statusText ?? emptyHint}</span>
        <span className="font-mono">{cursor ? `x: ${cursor.x}  y: ${cursor.y}` : "x: —  y: —"}</span>
        {cropping && (
          <span className="ml-auto font-medium text-orange">
            ● {rect ? `${Math.round(rect.w)} × ${Math.round(rect.h)} px` : `Draw: ${cropLabel}`}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── toolbar primitives ── */
function ToolbarButton({
  onClick,
  label,
  disabled,
  primary,
  title,
}: {
  onClick?: () => void;
  label: string;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "h-8 cursor-pointer rounded-sm px-[13px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        primary
          ? "bg-orange text-white hover:bg-orange-hover"
          : "border-[1.5px] border-border-strong bg-white text-text-secondary hover:bg-bg-surface hover:text-text-primary",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm transition-colors",
        active
          ? "bg-navy text-white"
          : "bg-transparent text-text-secondary hover:bg-bg-surface hover:text-text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function ZoomControl({ value, onChange }: { value: Zoom; onChange: (z: Zoom) => void }) {
  const options: { v: Zoom; label: string }[] = [
    { v: 0.5, label: "50%" },
    { v: 1, label: "100%" },
    { v: 2, label: "200%" },
    { v: -1, label: "Fit" },
  ];
  return (
    <div className="flex h-[30px] overflow-hidden rounded-sm border-[1.5px] border-border-strong">
      {options.map((o, i) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "px-[9px] text-[11.5px] font-medium transition-colors",
            i < options.length - 1 ? "border-r border-border" : "",
            value === o.v
              ? "bg-bg-muted text-text-primary"
              : "bg-white text-text-secondary hover:bg-bg-surface",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CursorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 3l6 16 2-7 7-2L5 3z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 11V5.5a1.5 1.5 0 1 1 3 0V11M10 11V4.5a1.5 1.5 0 1 1 3 0V11M13 11V5.5a1.5 1.5 0 1 1 3 0V13M16 8.5a1.5 1.5 0 1 1 3 0V15a6 6 0 0 1-6 6h-1.5a5 5 0 0 1-4.33-2.5L4 13.5a1.6 1.6 0 0 1 2.65-1.75L8 13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

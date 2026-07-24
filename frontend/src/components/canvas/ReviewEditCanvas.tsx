import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChevronNav } from "@/components/canvas/ChevronNav";
import { PageJump } from "@/components/canvas/PageJump";
import { PageRail } from "@/components/canvas/PageRail";
import { ToolToggle } from "@/components/canvas/ToolToggle";
import { ZoomControl, type Zoom } from "@/components/canvas/ZoomControl";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { useZoomToPointer } from "@/hooks/use-zoom-to-pointer";
import { useSpacePan, type CanvasTool } from "@/hooks/use-space-pan";
import type { LineType, Rect } from "@/lib/api/types";
import type { DerivedLine } from "@/lib/review/recompute";
import { Trash2 } from "lucide-react";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Props = {
  imageUrl: string | null;
  /** Derived lines for the current page (numbering already computed). */
  lines: DerivedLine[];
  selectedUid: string | null;
  onSelectLine: (uid: string | null) => void;
  /** The selected separator (line uid + cut index), or null. */
  selectedCut: { uid: string; index: number } | null;
  /** Select a separator (click or the start of a drag). */
  onSelectCut: (uid: string, cutIndex: number) => void;
  /** Delete a separator (its attached button, in canvas or panel). */
  onRemoveCut: (uid: string, cutIndex: number) => void;
  /** Localized title for the separator delete button (canvas has no i18n). */
  removeSepTitle: string;
  /** Move/resize a line's bbox (image-natural px). Coalesce key `bbox:{uid}`. */
  onUpdateLineBbox: (uid: string, bbox: Rect) => void;
  /** Add a separator cut at x (double-click, text lines). */
  onAddCut: (uid: string, x: number) => void;
  /** Drag an existing cut to x. Coalesce key `sep:{uid}:{i}`. */
  onMoveCut: (uid: string, cutIndex: number, x: number) => void;
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  processed?: Set<number>;
  reviewed?: Set<number>;
  /** Reports the page image's natural size once loaded (for default line sizing). */
  onNatural?: (n: { w: number; h: number }) => void;
  /** Toolbar-right content (unsaved / warning counters, undo-redo). */
  statusSlot?: ReactNode;
};

const TYPE_COLOR: Record<LineType, string> = {
  text: "var(--orange)",
  sura_header: "var(--navy)",
  besmella: "var(--success)",
};

const TYPE_LABEL: Record<LineType, string> = {
  text: "text",
  sura_header: "sura",
  besmella: "besmella",
};

/** Interactive page editor: drag/resize line boxes, drag/add aya separators. */
export function ReviewEditCanvas({
  imageUrl,
  lines,
  selectedUid,
  onSelectLine,
  selectedCut,
  onSelectCut,
  onRemoveCut,
  removeSepTitle,
  onUpdateLineBbox,
  onAddCut,
  onMoveCut,
  page,
  pageCount,
  onPageChange,
  processed,
  reviewed,
  onNatural,
  statusSlot,
}: Props) {
  const [tool, setTool] = useState<CanvasTool>("select");
  const { scrollRef: wrapRef, effectiveTool, handCursor, containerProps } = useSpacePan({ tool });

  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<Zoom>(-1); // -1 = fit
  const [drag, setDrag] = useState<
    | null
    | {
        kind: "move" | "resize";
        handle?: Handle;
        uid: string;
        startBbox: Rect;
        startX: number;
        startY: number;
      }
    | { kind: "sep"; uid: string; cutIndex: number }
  >(null);
  // Magnifier loupe shown at the cursor during a precision drag (see MagnifierLens).
  const [lens, setLens] = useState<{ x: number; y: number; imgX: number; imgY: number } | null>(
    null,
  );

  useEffect(() => setNatural(null), [imageUrl]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !imageUrl) return;
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, [imageUrl]);

  useEffect(() => {
    if (natural) onNatural?.(natural);
  }, [natural, onNatural]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapRef]);

  const scale = useMemo(() => {
    if (!natural) return 1;
    if (zoom === -1) {
      const s = Math.min((box.w - 32) / natural.w, (box.h - 32) / natural.h, 1);
      return s > 0 ? s : 1;
    }
    return zoom;
  }, [natural, box, zoom]);

  useCtrlWheelZoom({ ref: wrapRef, zoom: scale, onZoomChange: setZoom });
  useZoomToPointer({ scrollRef: wrapRef, imgRef, scale, enabled: zoom !== -1 });

  const dispW = natural ? natural.w * scale : 0;
  const dispH = natural ? natural.h * scale : 0;

  const clientToImg = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img || !natural) return null;
    const r = img.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * natural.w,
      y: ((e.clientY - r.top) / r.height) * natural.h,
    };
  };

  // Global pointer move/up while a drag is active.
  useEffect(() => {
    if (!drag) {
      setLens(null);
      return;
    }
    function onMove(e: PointerEvent) {
      const p = clientToImg(e);
      if (!p || !natural) return;
      // Loupe follows the cursor while resizing an edge or dragging a separator
      // (the precision ops) — skipped for a plain box move.
      const stage = stageRef.current;
      if (stage && drag!.kind !== "move") {
        const rect = stage.getBoundingClientRect();
        setLens({ x: e.clientX - rect.left, y: e.clientY - rect.top, imgX: p.x, imgY: p.y });
      }
      if (drag!.kind === "sep") {
        onMoveCut(drag!.uid, drag!.cutIndex, Math.round(p.x));
        return;
      }
      const dx = p.x - drag!.startX;
      const dy = p.y - drag!.startY;
      const sr = drag!.startBbox;
      if (drag!.kind === "move") {
        onUpdateLineBbox(drag!.uid, {
          x: Math.max(0, Math.min(natural.w - sr.w, Math.round(sr.x + dx))),
          y: Math.max(0, Math.min(natural.h - sr.h, Math.round(sr.y + dy))),
          w: sr.w,
          h: sr.h,
        });
      } else {
        let x1 = sr.x;
        let y1 = sr.y;
        let x2 = sr.x + sr.w;
        let y2 = sr.y + sr.h;
        const h = drag!.handle!;
        if (h.includes("w")) x1 = sr.x + dx;
        if (h.includes("e")) x2 = sr.x + sr.w + dx;
        if (h.includes("n")) y1 = sr.y + dy;
        if (h.includes("s")) y2 = sr.y + sr.h + dy;
        const nx = Math.max(0, Math.min(natural.w - 4, Math.min(x1, x2)));
        const ny = Math.max(0, Math.min(natural.h - 4, Math.min(y1, y2)));
        const nw = Math.max(4, Math.abs(x2 - x1));
        const nh = Math.max(4, Math.abs(y2 - y1));
        onUpdateLineBbox(drag!.uid, {
          x: Math.round(nx),
          y: Math.round(ny),
          w: Math.round(Math.min(natural.w - nx, nw)),
          h: Math.round(Math.min(natural.h - ny, nh)),
        });
      }
    }
    function onUp() {
      setDrag(null);
      setLens(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // clientToImg is stable given `natural`; re-subscribing on it is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, natural, onUpdateLineBbox, onMoveCut]);

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
      // Delete/Backspace removes the selected separator (only a separator — never
      // a whole line — so an accidental keypress can't wipe a line's geometry).
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedCut)
        onRemoveCut(selectedCut.uid, selectedCut.index);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, pageCount, onPageChange, selectedCut, onRemoveCut]);

  function startLineDrag(e: React.PointerEvent, line: DerivedLine, handle?: Handle) {
    e.stopPropagation();
    const p = clientToImg(e);
    if (!p) return;
    onSelectLine(line.uid);
    setDrag({
      kind: handle ? "resize" : "move",
      handle,
      uid: line.uid,
      startBbox: { ...line.bbox },
      startX: p.x,
      startY: p.y,
    });
  }

  function onLineDoubleClick(e: React.MouseEvent, line: DerivedLine) {
    if (line.type !== "text") return;
    e.stopPropagation();
    const p = clientToImg(e);
    if (!p) return;
    onAddCut(line.uid, Math.round(p.x));
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-page">
      {/* Toolbar */}
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3">
        <ToolToggle value={effectiveTool} onChange={setTool} />
        <div className="ml-auto flex items-center gap-3">
          {statusSlot}
          <ZoomControl value={zoom} onChange={setZoom} />
        </div>
      </div>

      {/* Canvas */}
      <div ref={stageRef} className="relative flex flex-1 overflow-hidden">
        <div
          ref={wrapRef}
          className="raqam-canvas-grid relative flex-1 overflow-auto outline-none"
          {...containerProps}
          onPointerDown={(e) => {
            containerProps.onPointerDown(e);
            if (effectiveTool !== "hand") onSelectLine(null);
          }}
          style={effectiveTool === "hand" ? { cursor: handCursor } : undefined}
        >
          {imageUrl ? (
            <div
              className="relative mx-auto my-4"
              style={{
                width: dispW || "auto",
                height: dispH || "auto",
                pointerEvents: effectiveTool === "hand" ? "none" : undefined,
              }}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt={`Page ${page}`}
                draggable={false}
                onLoad={(e) =>
                  setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                }
                style={{
                  width: dispW || "auto",
                  height: dispH || "auto",
                  display: "block",
                  userSelect: "none",
                  boxShadow: "var(--shadow-page)",
                  background: "white",
                }}
              />
              {natural &&
                lines.map((line) => (
                  <LineOverlay
                    key={line.uid}
                    line={line}
                    natural={natural}
                    selected={line.uid === selectedUid}
                    selectedCutIndex={selectedCut?.uid === line.uid ? selectedCut.index : null}
                    removeSepTitle={removeSepTitle}
                    onStartDrag={startLineDrag}
                    onDoubleClick={onLineDoubleClick}
                    onStartSepDrag={(uid, cutIndex) => {
                      onSelectCut(uid, cutIndex);
                      setDrag({ kind: "sep", uid, cutIndex });
                    }}
                    onRemoveSep={onRemoveCut}
                  />
                ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="rounded-md bg-white/80 px-6 py-4 text-[13px] text-text-secondary shadow-[var(--shadow-sm)]">
                No image for page {page}.
              </div>
            </div>
          )}
        </div>
        <ChevronNav page={page} pageCount={pageCount} onPageChange={onPageChange} />
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-pill border border-border bg-white/90 px-3 py-1.5 shadow-[var(--shadow-sm)] backdrop-blur">
          <PageJump page={page} pageCount={pageCount} onPageChange={onPageChange} />
        </div>
        {lens && natural && imageUrl && (
          <MagnifierLens
            x={lens.x}
            y={lens.y}
            imgX={lens.imgX}
            imgY={lens.imgY}
            natural={natural}
            scale={scale}
            imageUrl={imageUrl}
          />
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

// ── magnifier lens ────────────────────────────────────────────────────────────
const LENS_MAG = 2.5;
const LENS_R = 66; // css radius of the loupe
const LENS_MARGIN = 22;

/** A circular loupe near the cursor that magnifies the page image at the exact
 * point being dragged — the DOM analogue of FinalizeCanvas's canvas `drawLens`,
 * sampling the page <img> via background-image instead of canvas pixels. */
function MagnifierLens({
  x,
  y,
  imgX,
  imgY,
  natural,
  scale,
  imageUrl,
}: {
  x: number;
  y: number;
  imgX: number;
  imgY: number;
  natural: { w: number; h: number };
  scale: number;
  imageUrl: string;
}) {
  const dispW = natural.w * scale;
  const dispH = natural.h * scale;
  // sit above the cursor; drop below when too near the top edge
  let cy = y - LENS_R - LENS_MARGIN;
  if (cy - LENS_R < 4) cy = y + LENS_R + LENS_MARGIN;
  return (
    <div
      className="pointer-events-none absolute z-30 overflow-hidden rounded-full"
      style={{
        left: x - LENS_R,
        top: cy - LENS_R,
        width: LENS_R * 2,
        height: LENS_R * 2,
        backgroundColor: "white",
        backgroundImage: `url(${imageUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${dispW * LENS_MAG}px ${dispH * LENS_MAG}px`,
        backgroundPosition: `${LENS_R - imgX * scale * LENS_MAG}px ${LENS_R - imgY * scale * LENS_MAG}px`,
        boxShadow:
          "0 0 0 3px rgba(0,0,0,0.4), inset 0 0 0 1.5px rgba(255,255,255,0.9), var(--shadow-md)",
      }}
    >
      <div
        className="absolute"
        style={{
          left: LENS_R - 7,
          top: LENS_R,
          width: 14,
          borderTop: "1px solid rgba(255,141,106,0.95)",
        }}
      />
      <div
        className="absolute"
        style={{
          left: LENS_R,
          top: LENS_R - 7,
          height: 14,
          borderLeft: "1px solid rgba(255,141,106,0.95)",
        }}
      />
    </div>
  );
}

function LineOverlay({
  line,
  natural,
  selected,
  selectedCutIndex,
  removeSepTitle,
  onStartDrag,
  onDoubleClick,
  onStartSepDrag,
  onRemoveSep,
}: {
  line: DerivedLine;
  natural: { w: number; h: number };
  selected: boolean;
  /** Index of the selected separator on THIS line, or null. */
  selectedCutIndex: number | null;
  removeSepTitle: string;
  onStartDrag: (e: React.PointerEvent, line: DerivedLine, handle?: Handle) => void;
  onDoubleClick: (e: React.MouseEvent, line: DerivedLine) => void;
  onStartSepDrag: (uid: string, cutIndex: number) => void;
  onRemoveSep: (uid: string, cutIndex: number) => void;
}) {
  const c = TYPE_COLOR[line.type];
  const fill = `color-mix(in oklab, ${c} 12%, transparent)`;
  return (
    <div
      onPointerDown={(e) => onStartDrag(e, line)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => onDoubleClick(e, line)}
      className="absolute"
      style={{
        left: `${(line.bbox.x / natural.w) * 100}%`,
        top: `${(line.bbox.y / natural.h) * 100}%`,
        width: `${(line.bbox.w / natural.w) * 100}%`,
        height: `${(line.bbox.h / natural.h) * 100}%`,
        border: `2px solid ${c}`,
        background: fill,
        cursor: "move",
        touchAction: "none",
        boxShadow: selected ? `0 0 0 3px color-mix(in oklab, ${c} 35%, transparent)` : undefined,
        zIndex: selected ? 5 : 1,
      }}
    >
      {/* type badge */}
      <div
        className="pointer-events-none absolute -top-[20px] left-0 whitespace-nowrap rounded-pill px-[6px] py-[1px] text-[10px] font-semibold uppercase tracking-wider text-white"
        style={{ background: c }}
      >
        L{line.line_number} · {TYPE_LABEL[line.type]}
        {line.type !== "text" && line.sura ? ` · sura ${line.sura}` : ""}
      </div>

      {/* aya badges (text lines) */}
      {line.type === "text" &&
        line.segments.map((seg, i) => (
          <div
            key={`${i}_${seg.bbox.x}`}
            className="pointer-events-none absolute top-[2px] flex items-center justify-center"
            style={{
              left: `${((seg.bbox.x - line.bbox.x) / line.bbox.w) * 100}%`,
              width: `${(seg.bbox.w / line.bbox.w) * 100}%`,
              height: "16px",
            }}
          >
            <span
              className="rounded-pill px-[5px] text-[14px] font-bold leading-[1.4]"
              style={
                seg.overflow
                  ? {
                      background: "var(--error-bg)",
                      color: "var(--error)",
                      border: "1px solid var(--error)",
                    }
                  : { background: "var(--navy)", color: "white", border: "1px solid var(--border)" }
              }
            >
              {seg.aya}
              {!seg.has_separator ? "…" : ""}
            </span>
          </div>
        ))}

      {/* separator bars (text lines) — click to select, drag to move. The delete
          button is a CHILD of its bar, so the bar is its positioning context: it
          stays centred on the separator and rides along with it, no line-relative
          maths of its own. */}
      {line.type === "text" &&
        line.cuts.map((cx, ci) => {
          const sepSelected = ci === selectedCutIndex;
          const leftPct = ((cx - line.bbox.x) / line.bbox.w) * 100;
          return (
            <div
              key={ci}
              onPointerDown={(e) => {
                e.stopPropagation();
                onStartSepDrag(line.uid, ci);
              }}
              className="absolute -bottom-1 -top-1"
              style={{
                left: `${leftPct}%`,
                width: sepSelected ? "6px" : "4px",
                transform: "translateX(-3px)",
                cursor: "ew-resize",
                touchAction: "none",
                background: sepSelected
                  ? "var(--navy-light)"
                  : "color-mix(in oklab, var(--navy) 80%, transparent)",
                borderRadius: "2px",
                boxShadow: sepSelected
                  ? "0 0 0 2px color-mix(in oklab, var(--navy-light) 35%, transparent)"
                  : "0 0 0 1px color-mix(in oklab, var(--navy) 40%, transparent)",
                zIndex: sepSelected ? 8 : 6,
              }}
            >
              {sepSelected && (
                <button
                  type="button"
                  title={removeSepTitle}
                  aria-label={removeSepTitle}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveSep(line.uid, ci);
                  }}
                  className="sep-del-pop group absolute bottom-full left-1/2 mb-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white bg-error text-[11px] font-bold leading-none text-white shadow-md hover:bg-white hover:text-error hover:brightness-110"
                >
                  <Trash2 size={14} />
                  {/* notch: a diamond poking out the bottom, pointing down at the
                      separator, tinted to match the button (incl. hover invert) */}
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-full h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border-b border-r border-white bg-error group-hover:bg-white"
                  />
                </button>
              )}
            </div>
          );
        })}

      {/* resize handles (selected only) */}
      {selected &&
        (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
          <div
            key={h}
            onPointerDown={(e) => onStartDrag(e, line, h)}
            className="absolute h-[10px] w-[10px] rounded-[2px] border-2 bg-white"
            style={{
              borderColor: c,
              cursor: handleCursor(h),
              touchAction: "none",
              ...handlePos(h),
            }}
          />
        ))}
    </div>
  );
}

function handlePos(h: Handle): React.CSSProperties {
  const o = -5;
  const map: Record<Handle, React.CSSProperties> = {
    nw: { left: o, top: o },
    n: { left: "calc(50% - 5px)", top: o },
    ne: { right: o, top: o },
    e: { right: o, top: "calc(50% - 5px)" },
    se: { right: o, bottom: o },
    s: { left: "calc(50% - 5px)", bottom: o },
    sw: { left: o, bottom: o },
    w: { left: o, top: "calc(50% - 5px)" },
  };
  return map[h];
}

function handleCursor(h: Handle) {
  if (h === "n" || h === "s") return "ns-resize";
  if (h === "e" || h === "w") return "ew-resize";
  if (h === "ne" || h === "sw") return "nesw-resize";
  return "nwse-resize";
}

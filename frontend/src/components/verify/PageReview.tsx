import { useEffect, useMemo, useRef, useState } from "react";
import type { Line, Page } from "@/lib/verify/types";
import { useSpacePan } from "@/hooks/use-space-pan";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";

type Props = {
  page: Page;
  imageUrl: string | null;
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  /** Edits the line's bbox (move/resize); coords are in image-natural pixels. */
  onUpdateLineBbox: (lineId: string, bbox: Line["line_bbox"]) => void;
  /** Adds a separator cut (text lines) at the given x in image-natural pixels. */
  onAddSeparatorAt: (lineId: string, x: number) => void;
  /** Moves an existing separator cut to new x. */
  onMoveSeparator: (lineId: string, cutIndex: number, x: number) => void;
};

const TYPE_COLORS: Record<Line["type"], { stroke: string; fill: string; label: string }> = {
  sura_header: {
    stroke: "var(--orange)",
    fill: "color-mix(in oklab, var(--orange) 14%, transparent)",
    label: "sura",
  },
  basmala: {
    stroke: "var(--navy)",
    fill: "color-mix(in oklab, var(--navy) 12%, transparent)",
    label: "basmala",
  },
  text: {
    stroke: "var(--success)",
    fill: "color-mix(in oklab, var(--success) 10%, transparent)",
    label: "text",
  },
};

export function PageReview({
  page,
  imageUrl,
  selectedLineId,
  onSelectLine,
  onUpdateLineBbox,
  onAddSeparatorAt,
  onMoveSeparator,
}: Props) {
  const { scrollRef: wrapRef, effectiveTool, handCursor, containerProps } = useSpacePan();

  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<number>(-1); // -1 = fit
  const [drag, setDrag] = useState<
    | null
    | {
        kind: "move" | "resize";
        handle?: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
        lineId: string;
        startBbox: Line["line_bbox"];
        startX: number;
        startY: number;
      }
    | { kind: "sep"; lineId: string; cutIndex: number }
  >(null);

  useEffect(() => {
    setNatural(null);
  }, [imageUrl]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !imageUrl) return;
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, [imageUrl]);

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

  // Ctrl + wheel zoom
  useCtrlWheelZoom({ ref: wrapRef, zoom: scale, onZoomChange: setZoom });

  const dispW = natural ? natural.w * scale : 0;
  const dispH = natural ? natural.h * scale : 0;

  function clientToImg(e: { clientX: number; clientY: number }) {
    const img = imgRef.current;
    if (!img || !natural) return null;
    const r = img.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * natural.w,
      y: ((e.clientY - r.top) / r.height) * natural.h,
    };
  }

  // Global pointer move/up for active drag.
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const p = clientToImg(e);
      if (!p || !natural) return;
      if (drag!.kind === "sep") {
        onMoveSeparator(drag!.lineId, drag!.cutIndex, Math.round(p.x));
        return;
      }
      const dx = p.x - drag!.startX;
      const dy = p.y - drag!.startY;
      const sr = drag!.startBbox;
      if (drag!.kind === "move") {
        onUpdateLineBbox(drag!.lineId, {
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
        onUpdateLineBbox(drag!.lineId, {
          x: Math.round(nx),
          y: Math.round(ny),
          w: Math.round(Math.min(natural.w - nx, nw)),
          h: Math.round(Math.min(natural.h - ny, nh)),
        });
      }
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, natural, onUpdateLineBbox, onMoveSeparator]);

  function startLineDrag(
    e: React.PointerEvent,
    line: Line,
    handle?: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w",
  ) {
    e.stopPropagation();
    const p = clientToImg(e);
    if (!p) return;
    onSelectLine(line.id);
    setDrag({
      kind: handle ? "resize" : "move",
      handle,
      lineId: line.id,
      startBbox: { ...line.line_bbox },
      startX: p.x,
      startY: p.y,
    });
  }

  function onCanvasDoubleClick(e: React.MouseEvent, line: Line) {
    // Add a separator on double-click inside a text line.
    if (line.type !== "text") return;
    e.stopPropagation();
    const p = clientToImg(e);
    if (!p) return;
    onAddSeparatorAt(line.id, Math.round(p.x));
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg-page">
      {/* zoom strip */}
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3 text-[12px] text-text-secondary">
        <span className="font-mono">page {page.page_number}</span>
        <span className="text-text-muted">·</span>
        <span className="truncate">{page.image_filename}</span>
        <div className="ml-auto flex h-[28px] overflow-hidden rounded-sm border-[1.5px] border-border-strong">
          {[
            { v: 0.5, l: "50%" },
            { v: 1, l: "100%" },
            { v: 2, l: "200%" },
            { v: -1, l: "Fit" },
          ].map((o, i) => (
            <button
              key={o.l}
              type="button"
              onClick={() => setZoom(o.v)}
              className={[
                "px-[9px] text-[11.5px] font-medium",
                i < 3 ? "border-r border-border" : "",
                zoom === o.v
                  ? "bg-bg-muted text-text-primary"
                  : "bg-white text-text-secondary hover:bg-bg-surface",
              ].join(" ")}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>

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
              alt={page.image_filename}
              draggable={false}
              onLoad={(e) =>
                setNatural({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
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
              page.lines.map((line) => {
                const c = TYPE_COLORS[line.type];
                const left = (line.line_bbox.x / natural.w) * 100;
                const top = (line.line_bbox.y / natural.h) * 100;
                const width = (line.line_bbox.w / natural.w) * 100;
                const height = (line.line_bbox.h / natural.h) * 100;
                const selected = line.id === selectedLineId;

                return (
                  <div
                    key={line.id}
                    onPointerDown={(e) => startLineDrag(e, line)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => onCanvasDoubleClick(e, line)}
                    className="absolute"
                    style={{
                      left: `${left}%`,
                      top: `${top}%`,
                      width: `${width}%`,
                      height: `${height}%`,
                      border: `2px solid ${c.stroke}`,
                      background: c.fill,
                      cursor: "move",
                      touchAction: "none",
                      boxShadow: selected
                        ? `0 0 0 3px color-mix(in oklab, ${c.stroke} 35%, transparent)`
                        : undefined,
                      zIndex: selected ? 5 : 1,
                    }}
                  >
                    {/* type badge */}
                    <div
                      className="pointer-events-none absolute -top-[20px] left-0 rounded-pill px-[6px] py-[1px] text-[10px] font-semibold uppercase tracking-wider text-white"
                      style={{ background: c.stroke }}
                    >
                      L{line.line_number} · {c.label}
                      {line.type === "sura_header" && line.sura_number
                        ? ` · ${line.sura_number}`
                        : ""}
                      {line.type === "basmala" && line.sura_number
                        ? ` · sura ${line.sura_number}`
                        : ""}
                    </div>

                    {/* segment aya badges + separator markers (text lines) */}
                    {line.type === "text" &&
                      line.segments?.map((seg) => {
                        const segLeft = ((seg.bbox.x - line.line_bbox.x) / line.line_bbox.w) * 100;
                        const segWidth = (seg.bbox.w / line.line_bbox.w) * 100;
                        return (
                          <div
                            key={seg.id}
                            className="pointer-events-none absolute top-[2px] flex items-center justify-center"
                            style={{
                              left: `${segLeft}%`,
                              width: `${segWidth}%`,
                              height: "16px",
                            }}
                          >
                            <span
                              className="rounded-pill bg-white px-[4px] text-lg py-0 font-bold text-navy"
                              style={{ border: "1px solid var(--border)" }}
                            >
                              {seg.aya_number}
                              {seg.is_continuation ? "…" : ""}
                            </span>
                          </div>
                        );
                      })}
                    {line.type === "text" &&
                      line.separator_cuts?.map((cx, ci) => {
                        const relLeft = ((cx - line.line_bbox.x) / line.line_bbox.w) * 100;
                        return (
                          <div
                            key={ci}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              onSelectLine(line.id);
                              setDrag({ kind: "sep", lineId: line.id, cutIndex: ci });
                            }}
                            className="absolute -top-1 -bottom-1"
                            style={{
                              left: `${relLeft}%`,
                              width: "4px",
                              transform: "translateX(-3px)",
                              cursor: "ew-resize",
                              touchAction: "none",
                              background: "color-mix(in oklab, var(--error) 80%, transparent)",
                              borderRadius: "2px",
                              boxShadow:
                                "0 0 0 1px color-mix(in oklab, var(--error) 40%, transparent)",
                              zIndex: 6,
                            }}
                          />
                        );
                      })}

                    {/* resize handles (only when selected) */}
                    {selected &&
                      (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
                        <div
                          key={h}
                          onPointerDown={(e) => startLineDrag(e, line, h)}
                          className="absolute h-[10px] w-[10px] rounded-[2px] border-2 bg-white"
                          style={{
                            borderColor: c.stroke,
                            cursor: handleCursor(h),
                            touchAction: "none",
                            ...handlePos(h),
                          }}
                        />
                      ))}
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-md bg-white/80 px-6 py-4 text-[13px] text-text-secondary shadow-[var(--shadow-sm)]">
              Load the page image named “{page.image_filename}” to preview overlays.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function handlePos(h: string): React.CSSProperties {
  const o = -5;
  const map: Record<string, React.CSSProperties> = {
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
function handleCursor(h: string) {
  if (h === "n" || h === "s") return "ns-resize";
  if (h === "e" || h === "w") return "ew-resize";
  if (h === "ne" || h === "sw") return "nesw-resize";
  return "nwse-resize";
}

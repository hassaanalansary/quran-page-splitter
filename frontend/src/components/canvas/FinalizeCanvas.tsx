import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronNav } from "@/components/canvas/ChevronNav";
import { PageJump } from "@/components/canvas/PageJump";
import { PageRail } from "@/components/canvas/PageRail";
import type { EraseStroke, Rect } from "@/lib/api/types";

export type FinalizeTool = "select" | "erase" | "hand";
export type FinalizeBg = "white" | "dark" | "checker";

/** One line as the canvas needs it: its crop box (x/w = page column) + strokes. */
export type CanvasLine = {
  line_number: number;
  type: string;
  bbox: Rect;
  strokes: EraseStroke[];
  edited?: boolean;
};

type Box = { y: number; h: number };

type Props = {
  imageUrl: string | null;
  lines: CanvasLine[];
  selected: number | null;
  brushSize: number;
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  processed?: Set<number>;
  reviewed?: Set<number>;
  onSelectLine: (n: number | null) => void;
  /** Live during an edge drag (preview, no history). */
  onResizeLine: (n: number, box: Box) => void;
  /** On pointer-up ending a resize drag (commit to history). */
  onResizeCommit: (n: number, box: Box) => void;
  /** On pointer-up when an erase stroke completes. */
  onStroke: (n: number, stroke: EraseStroke) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  label?: string;
};

const PAD = 20;
const GAP = 48; // screen px between stacked line crops
const EDGE_TOL = 8; // screen px for grabbing a line's top/bottom edge
const ORANGE = "rgb(255,141,106)"; // canvas can't resolve the --orange CSS var

type LineRect = {
  line_number: number;
  dx: number;
  dy: number;
  dispW: number;
  dispH: number;
  scale: number;
  cropX: number;
  cropY: number;
  bbox: Rect;
};

/** Stacked WYSIWYG line-cut editor. Each line is composited independently from
 * its own source crop (near-white → transparent, its own erase strokes punched
 * out) — exactly as it exports — so edits to one line never touch another. */
export function FinalizeCanvas({
  imageUrl,
  lines,
  selected,
  brushSize,
  page,
  pageCount,
  onPageChange,
  processed,
  reviewed,
  onSelectLine,
  onResizeLine,
  onResizeCommit,
  onStroke,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  label,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transparentRef = useRef<HTMLCanvasElement | null>(null); // page: white→transparent
  const whiteInkRef = useRef<HTMLCanvasElement | null>(null); // page: ink recolored white
  const scratchRef = useRef<HTMLCanvasElement | null>(null); // reused per-line offscreen
  const rectsRef = useRef<LineRect[]>([]);
  const [ready, setReady] = useState(false);

  const [tool, setTool] = useState<FinalizeTool>("select");
  const [bg, setBg] = useState<FinalizeBg>("dark");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);

  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef<{ lineNumber: number; stroke: EraseStroke } | null>(null);
  const edgeRef = useRef<{
    lineNumber: number;
    edge: "top" | "bottom";
    start: Rect;
    grabY: number;
    scale: number;
    current: Box;
    anchorBottom: number;
  } | null>(null);
  const panRef = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<{ lineNumber: number; edge: "top" | "bottom" } | null>(
    null,
  );

  const effectiveTool: FinalizeTool = spaceHeld ? "hand" : shiftHeld ? "erase" : tool;

  // ── load image → build the transparent page + a white-ink copy (once) ────────
  useEffect(() => {
    setReady(false);
    transparentRef.current = null;
    whiteInkRef.current = null;
    if (!imageUrl) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const transparent = document.createElement("canvas");
      transparent.width = w;
      transparent.height = h;
      const tctx = transparent.getContext("2d");
      if (tctx) {
        tctx.drawImage(img, 0, 0);
        try {
          const d = tctx.getImageData(0, 0, w, h);
          const buf = d.data;
          for (let i = 0; i < buf.length; i += 4) {
            if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) buf[i + 3] = 0;
          }
          tctx.putImageData(d, 0, 0);
        } catch {
          // CORS-tainted (shouldn't happen same-origin) — keep opaque page.
        }
      }
      // white-ink version: recolor every remaining (ink) pixel white, keep alpha
      const white = document.createElement("canvas");
      white.width = w;
      white.height = h;
      const wctx = white.getContext("2d");
      if (wctx) {
        wctx.drawImage(transparent, 0, 0);
        wctx.globalCompositeOperation = "source-in";
        wctx.fillStyle = "#ffffff";
        wctx.fillRect(0, 0, w, h);
        wctx.globalCompositeOperation = "source-over";
      }
      transparentRef.current = transparent;
      whiteInkRef.current = white;
      setReady(true);
    };
    img.onerror = () => setReady(false);
    img.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [imageUrl]);

  // ── momentary tool keys: Space → hand, Shift → erase ─────────────────────────
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) {
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
      }
      if (e.key === "Shift" && !e.ctrlKey && !e.metaKey && !typing(e.target)) setShiftHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
      if (e.key === "Shift") setShiftHeld(false);
    };
    const blur = () => {
      setSpaceHeld(false);
      setShiftHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ── render ───────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    paintBackground(ctx, cssW, cssH, bg);

    const srcLayer = bg === "dark" ? whiteInkRef.current : transparentRef.current;
    rectsRef.current = [];
    if (!ready || !srcLayer || lines.length === 0) {
      ctx.fillStyle = bg === "dark" ? "#9a9a9a" : "#6b6860";
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillText(
        !imageUrl || lines.length === 0 ? "No lines to finalize." : "Rendering page…",
        16,
        28,
      );
      return;
    }

    const colW = lines[0].bbox.w || 1;
    const fit = Math.max(0.05, (cssW - PAD * 2) / colW);
    const scale = Math.max(0.05, fit * zoom);
    const centerX = cssW / 2 + pan.x;
    let cursorY = PAD + pan.y;

    const scratch = ensureCanvas(scratchRef);
    const sctx = scratch.getContext("2d");

    for (const line of lines) {
      const b = line.bbox;
      const dispW = b.w * scale;
      const dispH = b.h * scale;
      const dx = centerX - dispW / 2;
      // A top-edge drag keeps the line's bottom fixed so the grabbed edge follows
      // the pointer (grows/shrinks upward); every other line stacks top-down.
      const drag = edgeRef.current;
      const topAnchor =
        drag && drag.lineNumber === line.line_number && drag.edge === "top"
          ? drag.anchorBottom
          : null;
      const dy = topAnchor !== null ? topAnchor - dispH : cursorY;
      rectsRef.current.push({
        line_number: line.line_number,
        dx,
        dy,
        dispW,
        dispH,
        scale,
        cropX: b.x,
        cropY: b.y,
        bbox: b,
      });

      if (sctx && b.w > 0 && b.h > 0) {
        scratch.width = b.w;
        scratch.height = b.h;
        sctx.clearRect(0, 0, b.w, b.h);
        sctx.drawImage(srcLayer, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
        sctx.save();
        sctx.globalCompositeOperation = "destination-out";
        sctx.lineCap = "round";
        sctx.lineJoin = "round";
        applyStrokes(sctx, line.strokes, b.x, b.y);
        const act = activeRef.current;
        if (act && act.lineNumber === line.line_number) applyStrokes(sctx, [act.stroke], b.x, b.y);
        sctx.restore();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scratch, dx, dy, dispW, dispH);
        ctx.imageSmoothingEnabled = true;
      }

      const isSel = line.line_number === selected;
      // number label in the left gutter
      ctx.font = `${isSel ? "bold " : ""}11px ui-sans-serif, system-ui`;
      ctx.fillStyle = isSel ? ORANGE : bg === "dark" ? "#8a8a8a" : "#9a9a9a";
      ctx.textBaseline = "middle";
      ctx.fillText(String(line.line_number), Math.max(6, dx - 26), dy + dispH / 2);
      if (line.edited) {
        ctx.fillStyle = ORANGE;
        ctx.beginPath();
        ctx.arc(Math.max(6, dx - 26) + 18, dy + dispH / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isSel) {
        ctx.strokeStyle = "rgba(255,141,106,0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(dx - 0.5, dy - 0.5, dispW + 1, dispH + 1);
      }
      const hov = hoverEdge?.lineNumber === line.line_number ? hoverEdge.edge : null;
      if (isSel || hov) {
        for (const edge of ["top", "bottom"] as const) {
          const ey = edge === "top" ? dy : dy + dispH;
          ctx.fillStyle = hov === edge ? "rgba(255,141,106,0.95)" : "rgba(255,141,106,0.45)";
          ctx.fillRect(dx, ey - 1.5, dispW, 3);
        }
      }
      cursorY = (topAnchor !== null ? topAnchor : dy + dispH) + GAP;
    }
    ctx.textBaseline = "alphabetic";

    if (effectiveTool === "erase" && mouseRef.current) {
      const r = Math.max(2, (brushSize / 2) * scale);
      const { x, y } = mouseRef.current;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, r - 1.5), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Magnifier lens while dragging (erase stroke or edge resize) for precision.
    if ((activeRef.current || edgeRef.current) && mouseRef.current) {
      drawLens(ctx, canvas, mouseRef.current, dpr, bg);
    }
  }, [ready, imageUrl, bg, zoom, pan, lines, selected, hoverEdge, effectiveTool, brushSize]);

  useEffect(() => render(), [render]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(c);
    return () => ro.disconnect();
  }, [render]);

  // wheel: scroll vertically; Ctrl/Cmd + wheel zooms around the cursor
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = c.getBoundingClientRect();
        const cy = e.clientY - rect.top;
        setZoom((prev) => {
          const next = Math.max(0.1, Math.min(16, prev * Math.exp(-e.deltaY * 0.0015)));
          const ratio = next / prev;
          setPan((p) => ({ x: p.x * ratio, y: (cy - PAD) * (1 - ratio) + p.y * ratio }));
          return Number(next.toFixed(3));
        });
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);

  // ── pointer helpers ────────────────────────────────────────────────────────
  const lineAt = useCallback((cx: number, cy: number): LineRect | null => {
    for (const r of rectsRef.current) {
      if (cx >= r.dx && cx <= r.dx + r.dispW && cy >= r.dy && cy <= r.dy + r.dispH) return r;
    }
    return null;
  }, []);

  const edgeAt = useCallback((cx: number, cy: number) => {
    for (const r of rectsRef.current) {
      if (cx < r.dx - EDGE_TOL || cx > r.dx + r.dispW + EDGE_TOL) continue;
      if (Math.abs(cy - r.dy) <= EDGE_TOL) return { rect: r, edge: "top" as const };
      if (Math.abs(cy - (r.dy + r.dispH)) <= EDGE_TOL) return { rect: r, edge: "bottom" as const };
    }
    return null;
  }, []);

  const canvasXY = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasXY(e);
    canvasRef.current?.setPointerCapture(e.pointerId);

    if (effectiveTool === "hand") {
      panRef.current = { x, y, pan: { ...pan } };
      return;
    }
    if (effectiveTool === "erase") {
      const r = lineAt(x, y);
      if (!r) return;
      onSelectLine(r.line_number);
      const px = Math.round(r.cropX + (x - r.dx) / r.scale);
      const py = Math.round(r.cropY + (y - r.dy) / r.scale);
      activeRef.current = {
        lineNumber: r.line_number,
        stroke: { brush_size: brushSize, points: [[px, py]] },
      };
      render();
      return;
    }
    // select + resize
    const hit = edgeAt(x, y);
    if (hit) {
      onSelectLine(hit.rect.line_number);
      edgeRef.current = {
        lineNumber: hit.rect.line_number,
        edge: hit.edge,
        start: { ...hit.rect.bbox },
        grabY: y,
        scale: hit.rect.scale,
        current: { y: hit.rect.bbox.y, h: hit.rect.bbox.h },
        anchorBottom: hit.rect.dy + hit.rect.dispH,
      };
      return;
    }
    const r = lineAt(x, y);
    onSelectLine(r ? r.line_number : null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasXY(e);
    mouseRef.current = { x, y };

    if (panRef.current) {
      const p = panRef.current;
      setPan({ x: p.pan.x + (x - p.x), y: p.pan.y + (y - p.y) });
      return;
    }
    if (edgeRef.current) {
      const d = edgeRef.current;
      const deltaPage = (y - d.grabY) / d.scale;
      const bottom = d.start.y + d.start.h;
      let box: Box;
      if (d.edge === "top") {
        const ny = Math.max(0, Math.min(bottom - 1, Math.round(d.start.y + deltaPage)));
        box = { y: ny, h: Math.max(1, bottom - ny) };
      } else {
        box = { y: d.start.y, h: Math.max(1, Math.round(d.start.h + deltaPage)) };
      }
      d.current = box;
      onResizeLine(d.lineNumber, box);
      return;
    }
    if (activeRef.current) {
      const r = rectsRef.current.find((rr) => rr.line_number === activeRef.current!.lineNumber);
      if (!r) return;
      const px = Math.round(r.cropX + (x - r.dx) / r.scale);
      const py = Math.round(r.cropY + (y - r.dy) / r.scale);
      const pts = activeRef.current.stroke.points;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(px - last[0], py - last[1]) >= 1) {
        pts.push([px, py]);
        render();
      }
      return;
    }

    if (effectiveTool === "select") {
      const edge = edgeAt(x, y);
      const next = edge ? { lineNumber: edge.rect.line_number, edge: edge.edge } : null;
      setHoverEdge((prev) =>
        prev?.lineNumber === next?.lineNumber && prev?.edge === next?.edge ? prev : next,
      );
    } else if (hoverEdge) {
      setHoverEdge(null);
    }
    if (effectiveTool === "erase") render();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    const act = activeRef.current;
    if (act && act.stroke.points.length > 0) onStroke(act.lineNumber, act.stroke);
    const edge = edgeRef.current;
    if (edge) onResizeCommit(edge.lineNumber, edge.current);
    activeRef.current = null;
    edgeRef.current = null;
    panRef.current = null;
  };

  const cursor = useMemo(() => {
    if (effectiveTool === "hand") return panRef.current ? "grabbing" : "grab";
    if (effectiveTool === "erase") return "none";
    return hoverEdge ? "ns-resize" : "default";
  }, [effectiveTool, hoverEdge]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-border bg-white px-3">
        <PageJump page={page} pageCount={pageCount} onPageChange={onPageChange} label={label} />
        <Segmented<FinalizeTool>
          value={effectiveTool}
          onChange={setTool}
          options={[
            { v: "select", label: "Select" },
            { v: "erase", label: "Erase" },
            { v: "hand", label: "Hand" },
          ]}
          title="Select also resizes (drag a line edge). Hold Shift to erase, Space to pan."
        />
        <Segmented<FinalizeBg>
          value={bg}
          onChange={setBg}
          options={[
            { v: "white", label: "White" },
            { v: "dark", label: "Dark" },
            { v: "checker", label: "Grid" },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center overflow-hidden rounded-sm border border-border-strong">
            <ToolbarBtn onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
              ↶
            </ToolbarBtn>
            <ToolbarBtn onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
              ↷
            </ToolbarBtn>
          </div>
          <div className="flex items-center gap-1 rounded-sm border border-border-strong bg-white px-2 py-[3px] font-mono text-[11px] text-text-muted">
            <span>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="ml-1 cursor-pointer text-navy hover:underline"
              title="Reset zoom & pan"
            >
              fit
            </button>
          </div>
        </div>
      </div>

      <div className="raqam-canvas-grid relative flex-1 overflow-hidden">
        <ChevronNav page={page} pageCount={pageCount} onPageChange={onPageChange} />
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            mouseRef.current = null;
            setHoverEdge(null);
            render();
          }}
          className="h-full w-full"
          style={{ display: "block", cursor, touchAction: "none" }}
        />
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

// ── helpers ────────────────────────────────────────────────────────────────────

function ensureCanvas(ref: React.MutableRefObject<HTMLCanvasElement | null>) {
  if (!ref.current) ref.current = document.createElement("canvas");
  return ref.current;
}

function applyStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: EraseStroke[],
  ox: number,
  oy: number,
) {
  for (const s of strokes) {
    const brush = Math.max(1, s.brush_size);
    ctx.lineWidth = brush;
    ctx.beginPath();
    s.points.forEach(([px, py], i) => {
      const x = px - ox;
      const y = py - oy;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const [px, py] of s.points) {
      ctx.beginPath();
      ctx.arc(px - ox, py - oy, brush / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A circular loupe near the cursor that magnifies the region under it (sampled
 * from the already-rendered canvas) with a crosshair on the exact point. */
function drawLens(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  mouse: { x: number; y: number },
  dpr: number,
  bg: FinalizeBg,
) {
  const MAG = 2.5;
  const R = 66; // css radius of the lens
  const margin = 22;
  let cyCss = mouse.y - R - margin; // sit above the cursor …
  if (cyCss - R < 4) cyCss = mouse.y + R + margin; // … or below when near the top
  const sx = mouse.x * dpr;
  const sy = mouse.y * dpr;
  const lx = mouse.x * dpr;
  const ly = cyCss * dpr;
  const rDev = R * dpr;
  const srcR = rDev / MAG;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(lx, ly, rDev, 0, Math.PI * 2);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = bg === "dark" ? "#0b0b0b" : bg === "white" ? "#ffffff" : "#f4f4f4";
  ctx.fillRect(lx - rDev, ly - rDev, rDev * 2, rDev * 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    canvas,
    sx - srcR,
    sy - srcR,
    srcR * 2,
    srcR * 2,
    lx - rDev,
    ly - rDev,
    rDev * 2,
    rDev * 2,
  );
  ctx.restore();
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.arc(lx, ly, rDev, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(lx, ly, rDev, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,141,106,0.95)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(lx - 7 * dpr, ly);
  ctx.lineTo(lx + 7 * dpr, ly);
  ctx.moveTo(lx, ly - 7 * dpr);
  ctx.lineTo(lx, ly + 7 * dpr);
  ctx.stroke();
  ctx.restore();
}

function paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number, bg: FinalizeBg) {
  if (bg === "white") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  } else if (bg === "dark") {
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = "#f4f4f4";
    ctx.fillRect(0, 0, w, h);
    const sq = 12;
    ctx.fillStyle = "#dcdcdc";
    for (let y = 0; y < h; y += sq) {
      for (let x = 0; x < w; x += sq) {
        if (((x / sq + y / sq) | 0) % 2 === 0) ctx.fillRect(x, y, sq, sq);
      }
    }
  }
}

function ToolbarBtn({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-8 w-8 cursor-pointer text-[15px] text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  title,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string }[];
  title?: string;
}) {
  return (
    <div title={title} className="flex overflow-hidden rounded-sm border border-border-strong">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "h-8 cursor-pointer px-2.5 text-[11px] font-semibold transition-colors",
            value === o.v
              ? "bg-navy text-white"
              : "bg-white text-text-secondary hover:bg-bg-surface",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

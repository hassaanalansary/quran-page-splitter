import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Redo2, Undo2 } from "lucide-react";

import { LoadingState } from "@/components/app/SatrLoader";
import { PagePill } from "@/components/canvas/PagePill";
import { PageRail } from "@/components/canvas/PageRail";
import { ToolButton } from "@/components/canvas/ToolToggle";
import { ZoomControl, type Zoom } from "@/components/canvas/ZoomControl";
import type { EraseStroke, LineType, Rect } from "@/lib/api/types";
import { drawEdgeInkMask } from "@/lib/edgeInk";

export type FinalizeTool = "select" | "erase" | "hand";
export type FinalizeBg = "white" | "dark" | "checker";

/** One line as the canvas needs it: its crop box (x/w = page column) + strokes. */
export type CanvasLine = {
  line_number: number;
  type: LineType;
  bbox: Rect;
  strokes: EraseStroke[];
  /** Hide the ink reaching over the line's top or bottom edge, as the export cuts it. */
  eraseEdgeInk?: boolean;
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
  finalized?: Set<number>;
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
  /** Natural size of the rendered page, once loaded (for clamping edits). */
  onNatural?: (n: { w: number; h: number }) => void;
  /** Draw the edge ink an erasing line cuts, dimmed, so what it took can be checked.
   * A view only: the export still cuts it. */
  showErasedEdgeInk?: boolean;
};

const PAD = 20;
const GAP = 48; // screen px between stacked line crops
/** `Zoom` value for "none of the presets" — set once the wheel takes over. */
const CUSTOM_ZOOM: Zoom = 0;
const EDGE_TOL = 8; // screen px for grabbing a line's top/bottom edge
/** The selection's lapis, as the backdrop needs it: the dark theme's lapis on
 * the black backdrop, the light theme's on white and the grid. A canvas can't
 * read CSS variables, and the backdrops are fixed whatever the theme. */
function accent(bg: FinalizeBg, alpha = 1): string {
  return bg === "dark" ? `rgba(110,155,219,${alpha})` : `rgba(30,78,140,${alpha})`;
}
/** How strongly erased edge ink shows when it is revealed: faint enough to tell it
 * from the ink the line keeps. */
const ERASED_EDGE_ALPHA = 0.3;
/** Gold marks a line edited since it was saved, as everywhere. */
const EDITED = "#c9962e";
/** The eraser's ring, in --stop for the backdrop. */
const ERASER = { dark: "#e8735c", light: "#a8321f" } as const;
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

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
  finalized,
  onSelectLine,
  onResizeLine,
  onResizeCommit,
  onStroke,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  label,
  onNatural,
  showErasedEdgeInk = false,
}: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transparentRef = useRef<HTMLCanvasElement | null>(null); // page: white→transparent
  const whiteInkRef = useRef<HTMLCanvasElement | null>(null); // page: ink recolored white
  // Each line's edge-ink mask, kept until its box changes: finding it walks every
  // pixel of the crop, far too slow to redo on each pan or hover.
  const edgeMasksRef = useRef<Map<number, EdgeMask>>(new Map());
  // Each line as it is drawn — crop, strokes and edge ink cut — kept until one of
  // them changes, so a pan, a zoom or a hover only draws finished images.
  const compositesRef = useRef<Map<number, LineComposite>>(new Map());
  // The line under an eraser stroke being drawn: its image with the stroke so far,
  // which each frame only adds the newest points to.
  const activeCompositeRef = useRef<ActiveComposite | null>(null);
  // One frame at a time: every request before the frame paints shares it.
  const frameRef = useRef<number | null>(null);
  const renderRef = useRef<() => void>(() => undefined);
  // A resize drag tells the page its box at most once a frame.
  const resizeFrameRef = useRef<number | null>(null);
  const rectsRef = useRef<LineRect[]>([]);
  const [ready, setReady] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const [tool, setTool] = useState<FinalizeTool>("select");
  const [bg, setBg] = useState<FinalizeBg>("dark");
  // `zoom` is a multiplier over the fit-to-column scale; `zoomPreset` is only
  // which button of the shared ZoomControl is lit (those are natural-pixel
  // scales, like every other page).
  const [zoom, setZoom] = useState(1);
  const [zoomPreset, setZoomPreset] = useState<Zoom>(-1);
  // Mirrors `zoom` for the wheel handler, which is bound once and must read the
  // live value without nesting a setState inside another updater.
  const zoomRef = useRef(1);
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
  const [hoverLine, setHoverLine] = useState<number | null>(null);

  const effectiveTool: FinalizeTool = spaceHeld ? "hand" : shiftHeld ? "erase" : tool;

  // ── load image → build the transparent page + a white-ink copy (once) ────────
  useEffect(() => {
    setReady(false);
    transparentRef.current = null;
    whiteInkRef.current = null;
    edgeMasksRef.current.clear();
    compositesRef.current.clear();
    activeCompositeRef.current = null;
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
      setNatural({ w, h });
      setReady(true);
    };
    img.onerror = () => setReady(false);
    img.src = imageUrl;
  }, [imageUrl]);

  // Report the page size out (own effect, so an inline `onNatural` prop can't
  // re-trigger the loader above).
  useEffect(() => {
    if (natural) onNatural?.(natural);
  }, [natural, onNatural]);

  const resetView = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    setZoomPreset(-1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => resetView(), [imageUrl, resetView]);

  // ── momentary tool keys: Space → hand, Shift → erase ─────────────────────────
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
      }
      if (e.key === "Shift" && !e.ctrlKey && !e.metaKey) setShiftHeld(true);
      // V / E / H pick a tool for good, like the other canvases.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "v") setTool("select");
      else if (k === "e") setTool("erase");
      else if (k === "h") setTool("hand");
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
      // Still rendering: the writing loader over the canvas says so.
      if (!imageUrl || lines.length === 0) {
        ctx.fillStyle = bg === "dark" ? "#9a9a9a" : "#6b6860";
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillText(t("canvas.fin_noLines"), 16, 28);
      }
      return;
    }

    const colW = lines[0].bbox.w || 1;
    const fit = Math.max(0.05, (cssW - PAD * 2) / colW);
    const scale = Math.max(0.05, fit * zoom);
    const centerX = cssW / 2 + pan.x;
    let cursorY = PAD + pan.y;

    const dark = bg === "dark";
    const transparentPage = transparentRef.current;

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

      const isHover = line.line_number === hoverLine;
      // Hover tint goes UNDER the crop: the line is transparent where the paper
      // was, so the whole band lights up without washing out the ink.
      if (isHover) {
        ctx.fillStyle = accent(bg, 0.08);
        ctx.fillRect(dx, dy, dispW, dispH);
      }

      if (b.w > 0 && b.h > 0 && transparentPage) {
        const composite = composeLine(line, {
          source: srcLayer,
          transparentPage,
          dark,
          showErased: showErasedEdgeInk,
          composites: compositesRef.current,
          edgeMasks: edgeMasksRef.current,
        });
        const act = activeRef.current;
        const image =
          act && act.lineNumber === line.line_number
            ? drawActiveStroke(activeCompositeRef, composite.canvas, act, b)
            : composite.canvas;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, dx, dy, dispW, dispH);
        if (composite.erased) {
          ctx.globalAlpha = ERASED_EDGE_ALPHA;
          ctx.drawImage(composite.erased, dx, dy, dispW, dispH);
          ctx.globalAlpha = 1;
        }
        ctx.imageSmoothingEnabled = true;
      }

      const isSel = line.line_number === selected;
      // number label in the left gutter
      ctx.font = `600 11.5px ${MONO}`;
      ctx.fillStyle = isSel ? accent(bg) : bg === "dark" ? "#8a8a8a" : "#9a9a9a";
      ctx.textBaseline = "middle";
      ctx.fillText(String(line.line_number), Math.max(6, dx - 26), dy + dispH / 2);
      if (line.edited) {
        ctx.fillStyle = EDITED;
        ctx.beginPath();
        ctx.arc(Math.max(6, dx - 26) + 18, dy + dispH / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isSel || isHover) {
        ctx.strokeStyle = isSel ? accent(bg) : accent(bg, 0.5);
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.strokeRect(dx - 1, dy - 1, dispW + 2, dispH + 2);
      }
      const hov = hoverEdge?.lineNumber === line.line_number ? hoverEdge.edge : null;
      if (isSel || hov) {
        for (const edge of ["top", "bottom"] as const) {
          const ey = edge === "top" ? dy : dy + dispH;
          ctx.fillStyle = accent(bg, hov === edge ? 0.95 : 0.35);
          ctx.fillRect(dx, ey - 1.5, dispW, 3);
          // The grip in the middle of the edge says it can be dragged.
          if (isSel) {
            ctx.fillStyle = accent(bg);
            roundRect(ctx, dx + dispW / 2 - 23, ey - 4, 46, 8, 4);
            ctx.fill();
          }
        }
      }
      // The selected line's height and strokes, tagged above its end.
      if (isSel) {
        const tag = t("finalize.lineSummary", {
          h: Math.round(line.bbox.h),
          count: line.strokes.length,
        });
        ctx.font = `600 11px ${MONO}`;
        const tw = ctx.measureText(tag).width + 16;
        const tx = dx + dispW - tw + 2;
        const ty = dy - 26;
        ctx.fillStyle = accent(bg);
        roundRect(ctx, tx, ty, tw, 19, 4);
        ctx.fill();
        ctx.fillStyle = bg === "dark" ? "#0d1626" : "#ffffff";
        ctx.fillText(tag, tx + 8, ty + 10);
      }
      cursorY = (topAnchor !== null ? topAnchor : dy + dispH) + GAP;
    }
    ctx.textBaseline = "alphabetic";
    forgetLinesNotShown(lines, compositesRef.current, edgeMasksRef.current);

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
      ctx.strokeStyle = bg === "dark" ? ERASER.dark : ERASER.light;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Magnifier lens while dragging (erase stroke or edge resize) for precision.
    if ((activeRef.current || edgeRef.current) && mouseRef.current) {
      drawLens(ctx, canvas, mouseRef.current, dpr, bg);
    }
  }, [
    ready,
    imageUrl,
    bg,
    zoom,
    pan,
    lines,
    selected,
    hoverEdge,
    hoverLine,
    effectiveTool,
    brushSize,
    showErasedEdgeInk,
    t,
  ]);

  /** Draw on the next frame — once, however many times it is asked before then. */
  const scheduleRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      renderRef.current();
    });
  }, []);

  useEffect(() => {
    renderRef.current = render;
    scheduleRender();
  }, [render, scheduleRender]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => scheduleRender());
    ro.observe(c);
    return () => {
      ro.disconnect();
      // Forget a cancelled frame too: one still on record would read as already
      // coming, and nothing would ever draw again (StrictMode unmounts once).
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    };
  }, [scheduleRender]);

  /** Number of inter-line GAPs above `cy` — the part of the stack's y-mapping
   * that is constant in screen px (see `zoomAt`). */
  const gapsAbove = useCallback((cy: number) => {
    const rects = rectsRef.current;
    let above = 0;
    for (let i = 0; i < rects.length; i++) if (rects[i].dy <= cy) above = i;
    return above;
  }, []);

  /** Zoom to `next`, keeping the point at canvas coords (cx, cy) under the
   * pointer. The stack maps a page point to
   *   x = cssW/2 + pan.x + scale·(…)      y = PAD + pan.y + scale·(…) + GAP·n
   * so the anchor is measured from the canvas centre / top pad, and the GAP
   * run — fixed screen spacing, not scaled — is taken out first. */
  const zoomAt = useCallback(
    (to: number, cx: number, cy: number) => {
      const c = canvasRef.current;
      const prev = zoomRef.current;
      const next = Math.max(0.1, Math.min(16, to));
      if (!c || next === prev) return;
      const ratio = next / prev;
      const ax = cx - c.clientWidth / 2;
      const ay = cy - PAD - GAP * gapsAbove(cy);
      zoomRef.current = next;
      setZoom(next);
      setPan((p) => ({ x: ax * (1 - ratio) + p.x * ratio, y: ay * (1 - ratio) + p.y * ratio }));
    },
    [gapsAbove],
  );

  // wheel: scroll vertically; Ctrl/Cmd + wheel zooms around the cursor
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = c.getBoundingClientRect();
        const raw = Math.max(0.1, Math.min(16, zoomRef.current * Math.exp(-e.deltaY * 0.0015)));
        zoomAt(Number(raw.toFixed(3)), e.clientX - rect.left, e.clientY - rect.top);
        setZoomPreset(CUSTOM_ZOOM);
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /** Scale at which the column exactly fits the canvas — one unit of `zoom`. */
  const fitScale = useCallback(() => {
    const c = canvasRef.current;
    const colW = lines[0]?.bbox.w || 1;
    if (!c) return 1;
    return Math.max(0.05, (c.clientWidth - PAD * 2) / colW);
  }, [lines]);

  /** The shared preset control speaks in natural-pixel scales; translate one
   * into this canvas' fit-relative zoom, anchored on the middle of the view. */
  const applyZoomPreset = useCallback(
    (z: Zoom) => {
      setZoomPreset(z);
      if (z === -1) {
        resetView();
        return;
      }
      const c = canvasRef.current;
      if (!c) return;
      zoomAt(Number((z / fitScale()).toFixed(3)), c.clientWidth / 2, c.clientHeight / 2);
    },
    [fitScale, resetView, zoomAt],
  );

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
      scheduleRender();
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
      if (resizeFrameRef.current === null) {
        resizeFrameRef.current = requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          const drag = edgeRef.current;
          if (drag) onResizeLine(drag.lineNumber, drag.current);
        });
      }
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
        scheduleRender();
      }
      return;
    }

    if (effectiveTool === "select") {
      const edge = edgeAt(x, y);
      const next = edge ? { lineNumber: edge.rect.line_number, edge: edge.edge } : null;
      setHoverEdge((prev) =>
        prev?.lineNumber === next?.lineNumber && prev?.edge === next?.edge ? prev : next,
      );
      // The whole line is clickable, so the whole line lights up — not just the
      // few px of its edge (that's the resize affordance, above).
      const over = lineAt(x, y)?.line_number ?? null;
      setHoverLine((prev) => (prev === over ? prev : over));
    } else {
      if (hoverEdge) setHoverEdge(null);
      if (hoverLine !== null) setHoverLine(null);
    }
    if (effectiveTool === "erase") scheduleRender();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    const act = activeRef.current;
    if (act && act.stroke.points.length > 0) onStroke(act.lineNumber, act.stroke);
    const edge = edgeRef.current;
    if (edge) onResizeCommit(edge.lineNumber, edge.current);
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    activeRef.current = null;
    activeCompositeRef.current = null;
    edgeRef.current = null;
    panRef.current = null;
  };

  const cursor = useMemo(() => {
    if (effectiveTool === "hand") return panRef.current ? "grabbing" : "grab";
    if (effectiveTool === "erase") return "none";
    if (hoverEdge) return "ns-resize";
    return hoverLine !== null ? "pointer" : "default";
  }, [effectiveTool, hoverEdge, hoverLine]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar, on the well: the tools and the backdrop, the page pill, then
          undo, redo and zoom. */}
      <div
        data-tour="canvas-toolbar"
        className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2.5 bg-well px-4 py-3"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <div role="group" aria-label={t("canvas.toolGroup")} className={GROUP}>
            {(
              [
                ["select", t("canvas.tool_select"), "V", t("canvas.tool_selectTip")],
                ["erase", t("canvas.tool_erase"), "E", t("canvas.tool_eraseTip")],
                ["hand", t("canvas.tool_hand"), "H", t("canvas.tool_handTip")],
              ] as const
            ).map(([value, name, key, tip]) => (
              <Toggle
                key={value}
                pressed={effectiveTool === value}
                tone={value === "erase" ? "stop" : "ink"}
                onClick={() => setTool(value)}
                title={tip}
              >
                {name} <kbd className="font-mono text-[10.5px] opacity-70">{key}</kbd>
              </Toggle>
            ))}
          </div>
          <div
            role="group"
            aria-label={t("canvas.bgTitle")}
            title={t("canvas.bgTitle")}
            className={GROUP}
          >
            {(
              [
                ["white", t("canvas.bg_white")],
                ["dark", t("canvas.bg_dark")],
                ["checker", t("canvas.bg_grid")],
              ] as const
            ).map(([value, name]) => (
              <Toggle key={value} pressed={bg === value} onClick={() => setBg(value)}>
                {name}
              </Toggle>
            ))}
          </div>
        </div>
        <PagePill page={page} pageCount={pageCount} onPageChange={onPageChange} label={label} />
        <ZoomControl
          value={zoomPreset}
          onChange={applyZoomPreset}
          before={
            <>
              <ToolButton
                onClick={onUndo}
                disabled={!canUndo}
                title={t("canvas.undoTitle")}
                aria-label={t("canvas.undoTitle")}
              >
                <Undo2 size={16} aria-hidden="true" />
              </ToolButton>
              <ToolButton
                onClick={onRedo}
                disabled={!canRedo}
                title={t("canvas.redoTitle")}
                aria-label={t("canvas.redoTitle")}
              >
                <Redo2 size={16} aria-hidden="true" />
              </ToolButton>
            </>
          }
        />
      </div>

      {/* The strips, on a card set into the well; the canvas paints the backdrop. */}
      <div className="flex flex-1 overflow-hidden bg-well px-4 pb-4">
        <div className="relative flex-1 overflow-hidden rounded-card border border-rule">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              mouseRef.current = null;
              setHoverEdge(null);
              setHoverLine(null);
              scheduleRender();
            }}
            className="h-full w-full"
            style={{ display: "block", cursor, touchAction: "none" }}
          />
          {imageUrl && lines.length > 0 && !ready && (
            <LoadingState className="pointer-events-none absolute inset-0 justify-center text-[12.5px] text-ink-3">
              {t("canvas.fin_rendering")}
            </LoadingState>
          )}
        </div>
      </div>

      <PageRail
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        processed={processed}
        reviewed={reviewed}
        finalized={finalized}
      />
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

type EdgeMask = { box: string; mask: HTMLCanvasElement | null };

/** One line drawn as it exports, and what it was drawn from: a change to any of
 * those draws it again. */
type LineComposite = {
  box: string;
  strokes: EraseStroke[];
  eraseEdgeInk: boolean;
  dark: boolean;
  showErased: boolean;
  canvas: HTMLCanvasElement;
  /** The edge ink the line cuts, alone — only while it is shown. */
  erased: HTMLCanvasElement | null;
};

/** The line under an eraser stroke being drawn, the stroke's points so far on it. */
type ActiveComposite = {
  stroke: EraseStroke;
  base: HTMLCanvasElement;
  canvas: HTMLCanvasElement;
  applied: number;
};

type CompositeSources = {
  /** The page as the backdrop shows it: ink white on dark, as printed otherwise. */
  source: HTMLCanvasElement;
  /** The page with its paper transparent: what the edge-ink rule reads. */
  transparentPage: HTMLCanvasElement;
  dark: boolean;
  showErased: boolean;
  composites: Map<number, LineComposite>;
  edgeMasks: Map<number, EdgeMask>;
};

/** The line as it exports — its crop, its eraser strokes and its edge ink cut —
 * drawn again only when one of those changed. */
function composeLine(line: CanvasLine, sources: CompositeSources): LineComposite {
  const b = line.bbox;
  const box = `${b.x},${b.y},${b.w},${b.h}`;
  const eraseEdgeInk = !!line.eraseEdgeInk;
  const cached = sources.composites.get(line.line_number);
  if (
    cached &&
    cached.box === box &&
    cached.strokes === line.strokes &&
    cached.eraseEdgeInk === eraseEdgeInk &&
    cached.dark === sources.dark &&
    cached.showErased === sources.showErased
  ) {
    return cached;
  }
  const canvas = createCanvas(b.w, b.h);
  const ctx = canvas.getContext("2d");
  let erased: HTMLCanvasElement | null = null;
  if (ctx) {
    ctx.drawImage(sources.source, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    applyStrokes(ctx, line.strokes, b.x, b.y);
    const mask = eraseEdgeInk ? findEdgeMask(line.line_number, b, box, sources) : null;
    if (mask) {
      // Before it is cut: the edge ink alone, eraser strokes already taken out.
      if (sources.showErased) erased = cutOutEdgeInk(canvas, mask);
      ctx.drawImage(mask, 0, 0);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  const composite = {
    box,
    strokes: line.strokes,
    eraseEdgeInk,
    dark: sources.dark,
    showErased: sources.showErased,
    canvas,
    erased,
  };
  sources.composites.set(line.line_number, composite);
  return composite;
}

/** The line's edge-ink mask, found again only when its box changed. */
function findEdgeMask(
  lineNumber: number,
  b: Rect,
  box: string,
  sources: CompositeSources,
): HTMLCanvasElement | null {
  let cached = sources.edgeMasks.get(lineNumber);
  if (!cached || cached.box !== box) {
    cached = { box, mask: drawEdgeInkMask(sources.transparentPage, b) };
    sources.edgeMasks.set(lineNumber, cached);
  }
  return cached.mask;
}

/** The ink a mask covers, alone, on a canvas of its own. */
function cutOutEdgeInk(crop: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement | null {
  const erased = createCanvas(crop.width, crop.height);
  const ectx = erased.getContext("2d");
  if (!ectx) return null;
  ectx.drawImage(crop, 0, 0);
  ectx.globalCompositeOperation = "destination-in";
  ectx.drawImage(mask, 0, 0);
  return erased;
}

/** The line with the stroke being drawn on it: copied once from the line's image
 * when the stroke starts, then only the points added since the last frame. */
function drawActiveStroke(
  ref: { current: ActiveComposite | null },
  base: HTMLCanvasElement,
  act: { stroke: EraseStroke },
  b: Rect,
): HTMLCanvasElement {
  let active = ref.current;
  if (!active || active.stroke !== act.stroke || active.base !== base) {
    const canvas = createCanvas(base.width, base.height);
    canvas.getContext("2d")?.drawImage(base, 0, 0);
    active = { stroke: act.stroke, base, canvas, applied: 0 };
    ref.current = active;
  }
  const points = act.stroke.points;
  const ctx = active.canvas.getContext("2d");
  if (ctx && points.length > active.applied) {
    const from = Math.max(0, active.applied - 1);
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    applyStrokes(ctx, [{ ...act.stroke, points: points.slice(from) }], b.x, b.y);
    ctx.restore();
    active.applied = points.length;
  }
  return active.canvas;
}

/** Drop what is kept for lines no longer on the canvas. */
function forgetLinesNotShown(
  lines: CanvasLine[],
  composites: Map<number, LineComposite>,
  edgeMasks: Map<number, EdgeMask>,
) {
  if (composites.size <= lines.length && edgeMasks.size <= lines.length) return;
  const shown = new Set(lines.map((line) => line.line_number));
  for (const lineNumber of [...composites.keys()])
    if (!shown.has(lineNumber)) composites.delete(lineNumber);
  for (const lineNumber of [...edgeMasks.keys()])
    if (!shown.has(lineNumber)) edgeMasks.delete(lineNumber);
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
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
  ctx.fillStyle = bg === "dark" ? "#0b0b0b" : "#ffffff";
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
  ctx.strokeStyle = accent(bg, 0.95);
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
    // The grid: a dot every 16 px on white, fixed like the other two.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#cfc3ae";
    for (let y = 8; y < h; y += 16) {
      for (let x = 8; x < w; x += 16) ctx.fillRect(x - 0.5, y - 0.5, 1.2, 1.2);
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A toolbar group: the pill every canvas toolbar control sits in. */
const GROUP = "inline-flex items-center gap-1 rounded-lg border border-rule bg-sheet p-[3px]";

/** A text button in a toolbar group; pressed is ink, or --stop for the eraser. */
function Toggle({
  pressed,
  tone = "ink",
  onClick,
  title,
  children,
}: {
  pressed: boolean;
  tone?: "ink" | "stop";
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      className={`h-[30px] cursor-pointer rounded-[6px] px-2.5 text-[13px] transition-colors ${
        pressed
          ? tone === "stop"
            ? "bg-stop font-semibold text-on-stop"
            : "bg-ink font-semibold text-paper"
          : "font-medium text-ink-2 hover:bg-sunk hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

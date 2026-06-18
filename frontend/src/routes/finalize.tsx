import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/upload/AppHeader";
import {
  cutPageImageUrl,
  exportLinePngs,
  loadCutReviewResults,
  loadCutReviewStatus,
  saveCutEdits,
  type CutEdits,
  type CutReviewPayload,
  type EraseStroke,
  type LineEdit,
  type PageEdit,
} from "@/lib/api/cutReview";

export const Route = createFileRoute("/finalize")({
  head: () => ({
    meta: [
      { title: "Finalize — Raqam" },
      {
        name: "description",
        content: "Adjust line cuts and erase stray strokes before exporting line PNGs.",
      },
    ],
  }),
  component: FinalizePage,
});

/* ─────────────────────── data shape (loose mirror of pipeline) ────────────────────── */

type Bbox = { x: number; y: number; w: number; h: number };
type Line = {
  line_number: number;
  type: string;
  line_bbox: Bbox;
  segments?: unknown[];
  separator_cuts?: number[];
  sura_number?: number;
};
type Page = {
  page_number: number;
  image_filename?: string;
  page_image_filename?: string;
  crop_box?: Bbox;
  lines: Line[];
};
type Data = { pages: Page[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown, f = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : f;
}
function asBbox(v: unknown, f: Bbox = { x: 0, y: 0, w: 1, h: 1 }): Bbox {
  if (!isObj(v)) return f;
  return {
    x: num(v.x, f.x),
    y: num(v.y, f.y),
    w: Math.max(1, num(v.w ?? v.width, f.w)),
    h: Math.max(1, num(v.h ?? v.height, f.h)),
  };
}
function normalizeData(raw: unknown): Data {
  if (!isObj(raw)) return { pages: [] };
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  return {
    pages: pages.filter(isObj).map((p, pi): Page => {
      const lines = Array.isArray(p.lines) ? p.lines : [];
      const cb = asBbox(p.crop_box ?? p.cropBox);
      return {
        page_number: num(p.page_number, pi + 1),
        image_filename: typeof p.image_filename === "string" ? p.image_filename : undefined,
        page_image_filename:
          typeof p.page_image_filename === "string"
            ? p.page_image_filename
            : typeof p.image_filename === "string"
              ? p.image_filename
              : undefined,
        crop_box: cb,
        lines: lines.filter(isObj).map((l, li): Line => {
          const rawBox = asBbox(l.line_bbox ?? l.bbox, {
            x: cb.x,
            y: li * 120,
            w: cb.w,
            h: 80,
          });
          // Width and X are locked to the page crop box — every line shares
          // the same horizontal extent. Only Y/H come from the source bbox.
          const lockedBox: Bbox = { x: cb.x, y: rawBox.y, w: cb.w, h: rawBox.h };
          return {
            line_number: num(l.line_number, li + 1),
            type: typeof l.type === "string" ? l.type : "text",
            line_bbox: lockedBox,
            segments: Array.isArray(l.segments) ? l.segments : undefined,
            separator_cuts: Array.isArray(l.separator_cuts)
              ? (l.separator_cuts.map((n) => num(n)) as number[])
              : undefined,
            sura_number: l.sura_number == null ? undefined : num(l.sura_number),
          };
        }),
      };
    }),
  };
}

/* ─────────────────────────── component ─────────────────────────── */

function FinalizePage() {
  const [payload, setPayload] = useState<CutReviewPayload | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [edits, setEdits] = useState<CutEdits>({ pages: [] });
  const [pageIndex, setPageIndex] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const [brushSize, setBrushSize] = useState(16);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [tool, setTool] = useState<"select" | "hand">("select");
  type BgMode = "white" | "black" | "checker" | "dots";
  const [bgMode, setBgMode] = useState<BgMode>("white");
  const [zoomMult, setZoomMult] = useState(1); // 1 = fit-to-view
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [loadState, setLoadState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" }
  >({ kind: "idle" });
  const [busy, setBusy] = useState<null | "saving" | "exporting">(null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<{
    scale: number;
    offsetX: number;
    offsetY: number;
    bbox: Bbox;
    width: number;
    height: number;
  } | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const activeStrokeRef = useRef<EraseStroke | null>(null);
  const panDragRef = useRef<{
    startX: number;
    startY: number;
    startPan: { x: number; y: number };
  } | null>(null);
  const edgeDragRef = useRef<{
    edge: "top" | "bottom";
    startBox: Bbox;
  } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<"top" | "bottom" | null>(null);
  const effectiveTool: "select" | "hand" = tool === "hand" || spaceHeld ? "hand" : "select";

  /* ───────── load on mount ───────── */
  const applyPayload = useCallback((p: CutReviewPayload) => {
    setPayload(p);
    setData(normalizeData(p.data));
    setEdits(
      p.edits && typeof p.edits === "object"
        ? { pages: Array.isArray(p.edits.pages) ? p.edits.pages : [] }
        : { pages: [] },
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadState({ kind: "loading" });
      try {
        const status = await loadCutReviewStatus();
        if (!status.cut_review_available) {
          throw new Error("No coordinate data available yet — run upload then verify first.");
        }
        const p = await loadCutReviewResults();
        if (cancelled) return;
        applyPayload(p);
        setPageIndex(0);
        setLineIndex(0);
        setLoadState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        setLoadState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyPayload]);

  const page: Page | null = data?.pages[pageIndex] ?? null;
  const line: Line | null = page?.lines[lineIndex] ?? null;

  /* ───────── load image for current page ───────── */
  useEffect(() => {
    setImageReady(false);
    imageRef.current = null;
    const name = page?.page_image_filename || page?.image_filename;
    if (!name) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      setImageReady(true);
    };
    img.onerror = () => {
      imageRef.current = null;
      setImageReady(false);
    };
    img.src = cutPageImageUrl(name);
  }, [page?.page_image_filename, page?.image_filename]);

  /* ───────── edits helpers ───────── */

  function findPageEdit(eds: CutEdits, p: Page): PageEdit | null {
    return (
      eds.pages.find(
        (pe) =>
          (pe.page_image_filename && pe.page_image_filename === p.page_image_filename) ||
          Number(pe.page_number) === Number(p.page_number),
      ) ?? null
    );
  }
  function findLineEdit(pe: PageEdit | null, l: Line): LineEdit | null {
    if (!pe) return null;
    return pe.lines.find((le) => Number(le.line_number) === Number(l.line_number)) ?? null;
  }
  const currentLineEdit = useMemo<LineEdit | null>(() => {
    if (!page || !line) return null;
    return findLineEdit(findPageEdit(edits, page), line);
  }, [edits, page, line]);

  function mutateLineEdit(mutator: (le: LineEdit) => LineEdit | null) {
    if (!page || !line) return;
    setEdits((prev) => {
      const next: CutEdits = {
        ...prev,
        pages: prev.pages.map((p) => ({ ...p, lines: [...p.lines] })),
      };
      let pe = next.pages.find(
        (p) =>
          (p.page_image_filename && p.page_image_filename === page.page_image_filename) ||
          Number(p.page_number) === Number(page.page_number),
      );
      if (!pe) {
        pe = {
          page_number: page.page_number,
          image_filename: page.image_filename,
          page_image_filename: page.page_image_filename,
          lines: [],
        };
        next.pages.push(pe);
      }
      const idx = pe.lines.findIndex((le) => Number(le.line_number) === Number(line.line_number));
      const existing: LineEdit = idx >= 0 ? pe.lines[idx] : { line_number: line.line_number };
      const updated = mutator({ ...existing });
      if (!updated || (!updated.bbox_override && !updated.erase_strokes?.length)) {
        if (idx >= 0) pe.lines.splice(idx, 1);
      } else if (idx >= 0) {
        pe.lines[idx] = updated;
      } else {
        pe.lines.push(updated);
      }
      next.pages = next.pages.filter((p) => p.lines.length > 0);
      return next;
    });
  }

  function setLineBbox(next: Bbox) {
    if (!page || !line) return;
    // Width and x are locked to the page crop_box.
    const locked: Bbox = {
      x: page.crop_box?.x ?? next.x,
      y: Math.max(0, Math.round(next.y)),
      w: page.crop_box?.w ?? next.w,
      h: Math.max(1, Math.round(next.h)),
    };
    setData((prev) => {
      if (!prev) return prev;
      const pages = prev.pages.map((p, pi) => {
        if (pi !== pageIndex) return p;
        return {
          ...p,
          lines: p.lines.map((l, li) => (li === lineIndex ? { ...l, line_bbox: locked } : l)),
        };
      });
      return { ...prev, pages };
    });
    mutateLineEdit((le) => ({ ...le, bbox_override: locked }));
  }

  function resetLineBox() {
    if (!page || !line || !payload) return;
    const src = normalizeData(payload.source_data);
    const sp = src.pages[pageIndex];
    const sl = sp?.lines.find((sl) => Number(sl.line_number) === Number(line.line_number));
    if (!sl) return;
    setData((prev) => {
      if (!prev) return prev;
      const pages = prev.pages.map((p, pi) => {
        if (pi !== pageIndex) return p;
        return {
          ...p,
          lines: p.lines.map((l, li) =>
            li === lineIndex ? { ...l, line_bbox: { ...sl.line_bbox } } : l,
          ),
        };
      });
      return { ...prev, pages };
    });
    mutateLineEdit((le) => {
      const cleaned = { ...le };
      delete cleaned.bbox_override;
      return cleaned;
    });
  }

  function undoStroke() {
    mutateLineEdit((le) => {
      if (!le.erase_strokes?.length) return le;
      const remaining = le.erase_strokes.slice(0, -1);
      const next: LineEdit = { ...le };
      if (remaining.length) next.erase_strokes = remaining;
      else delete next.erase_strokes;
      return next;
    });
  }
  function clearStrokes() {
    mutateLineEdit((le) => {
      const next = { ...le };
      delete next.erase_strokes;
      return next;
    });
  }

  /* ───────── keyboard ───────── */
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
      if (e.code === "Space") setSpaceHeld(false);
    };
    const blur = () => {
      setShiftHeld(false);
      setSpaceHeld(false);
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

  // Reset zoom/pan when switching line or page.
  useEffect(() => {
    setZoomMult(1);
    setPan({ x: 0, y: 0 });
  }, [pageIndex, lineIndex]);

  /* ───────── canvas render ───────── */

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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    // ── Background ──
    if (bgMode === "white") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cssW, cssH);
    } else if (bgMode === "black") {
      ctx.fillStyle = "#0b0b0b";
      ctx.fillRect(0, 0, cssW, cssH);
    } else if (bgMode === "checker") {
      ctx.fillStyle = "#f4f4f4";
      ctx.fillRect(0, 0, cssW, cssH);
      const sq = 14;
      ctx.fillStyle = "#dcdcdc";
      for (let yy = 0; yy < cssH; yy += sq) {
        for (let xx = 0; xx < cssW; xx += sq) {
          if (((xx / sq + yy / sq) | 0) % 2 === 0) ctx.fillRect(xx, yy, sq, sq);
        }
      }
    } else if (bgMode === "dots") {
      ctx.fillStyle = "#f7f7f7";
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = "#c8c8c8";
      const step = 18;
      for (let yy = step / 2; yy < cssH; yy += step) {
        for (let xx = step / 2; xx < cssW; xx += step) {
          ctx.beginPath();
          ctx.arc(xx, yy, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    viewRef.current = null;

    const img = imageRef.current;
    if (!img || !line || !imageReady) {
      ctx.fillStyle = bgMode === "black" ? "#a0a0a0" : "#6b6860";
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillText(line ? "Loading page image..." : "No line selected.", 16, 28);
      return;
    }

    const box = line.line_bbox;
    const width = Math.max(1, box.w);
    const height = Math.max(1, box.h);

    // Offscreen at native resolution → make near-white transparent → apply erasers.
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;
    try {
      offCtx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, width, height);
    } catch {
      // Drawing can throw if the image is tainted; skip cleanup in that case.
    }
    try {
      const d = offCtx.getImageData(0, 0, width, height);
      const buf = d.data;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) {
          buf[i + 3] = 0;
        }
      }
      offCtx.putImageData(d, 0, 0);
    } catch {
      // CORS-tainted; skip transparency pass.
    }
    const strokes = currentLineEdit?.erase_strokes ?? [];
    offCtx.save();
    offCtx.globalCompositeOperation = "destination-out";
    offCtx.lineCap = "round";
    offCtx.lineJoin = "round";
    for (const s of strokes) {
      const brush = Math.max(1, s.brush_size);
      offCtx.lineWidth = brush;
      offCtx.beginPath();
      s.points.forEach(([px, py], i) => {
        const x = px - box.x;
        const y = py - box.y;
        if (i === 0) offCtx.moveTo(x, y);
        else offCtx.lineTo(x, y);
      });
      offCtx.stroke();
      for (const [px, py] of s.points) {
        offCtx.beginPath();
        offCtx.arc(px - box.x, py - box.y, brush / 2, 0, Math.PI * 2);
        offCtx.fill();
      }
    }
    offCtx.restore();

    const pad = 24;
    const maxW = Math.max(1, cssW - pad * 2);
    const maxH = Math.max(1, cssH - pad * 2);
    const fitScale = Math.max(0.02, Math.min(maxW / width, maxH / height));
    const scale = Math.max(0.02, fitScale * zoomMult);
    const drawW = width * scale;
    const drawH = height * scale;
    const offsetX = (cssW - drawW) / 2 + pan.x;
    const offsetY = (cssH - drawH) / 2 + pan.y;
    viewRef.current = { scale, offsetX, offsetY, bbox: { ...box }, width, height };

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, offsetX, offsetY, drawW, drawH);
    ctx.restore();

    // Frame
    ctx.strokeStyle = bgMode === "black" ? "rgba(232, 213, 163, 0.85)" : "rgba(40, 56, 92, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(offsetX, offsetY, drawW, drawH);

    // Separator hints
    if (line.separator_cuts?.length) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 141, 106, 0.75)";
      ctx.setLineDash([8, 6]);
      for (const cx of line.separator_cuts) {
        const x = offsetX + (cx - box.x) * scale;
        if (x < offsetX || x > offsetX + drawW) continue;
        ctx.beginPath();
        ctx.moveTo(x, offsetY);
        ctx.lineTo(x, offsetY + drawH);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Top/bottom edge highlights
    if (hoverEdge) {
      ctx.fillStyle = "rgba(255, 141, 106, 0.45)";
      const eh = 4;
      const y = hoverEdge === "top" ? offsetY - eh / 2 : offsetY + drawH - eh / 2;
      ctx.fillRect(offsetX, y, drawW, eh);
    }

    // Brush cursor
    if (shiftHeld && mouseRef.current) {
      const r = Math.max(2, (brushSize / 2) * scale);
      const { x, y } = mouseRef.current;
      ctx.save();
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
      ctx.restore();
    }
  }, [line, imageReady, currentLineEdit, hoverEdge, shiftHeld, brushSize, bgMode, zoomMult, pan]);

  // Ctrl/Cmd + wheel zoom around the cursor.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const canvasEl = c;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = canvasEl.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setZoomMult((prev) => {
        const next = Math.max(0.1, Math.min(16, prev * factor));
        const ratio = next / prev;
        // Keep cursor anchor stable: adjust pan so the point under cursor stays put.
        setPan((p) => {
          const view = viewRef.current;
          if (!view) return p;
          const dx = cx - (view.offsetX + (view.width * view.scale) / 2);
          const dy = cy - (view.offsetY + (view.height * view.scale) / 2);
          return {
            x: p.x + dx * (1 - ratio),
            y: p.y + dy * (1 - ratio),
          };
        });
        return Number(next.toFixed(3));
      });
    }
    canvasEl.addEventListener("wheel", onWheel, { passive: false });
    return () => canvasEl.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    render();
  }, [render]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(c);
    return () => ro.disconnect();
  }, [render]);

  /* ───────── pointer events ───────── */

  function localFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const view = viewRef.current;
    if (!view) return { local: { x: 0, y: 0 }, css: { x: 0, y: 0 }, view: null as null };
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    return {
      css: { x: cssX, y: cssY },
      local: {
        x: (cssX - view.offsetX) / view.scale,
        y: (cssY - view.offsetY) / view.scale,
      },
      view,
    };
  }
  function edgeAt(localY: number, view: NonNullable<typeof viewRef.current>) {
    const tol = 10 / view.scale;
    if (Math.abs(localY) <= tol) return "top" as const;
    if (Math.abs(localY - view.height) <= tol) return "bottom" as const;
    return null;
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!line) return;
    const { local, view, css } = localFromEvent(e);
    if (!view) return;
    canvasRef.current?.setPointerCapture(e.pointerId);

    // Hand/pan tool (or Space held) takes priority.
    if (effectiveTool === "hand") {
      panDragRef.current = { startX: css.x, startY: css.y, startPan: { ...pan } };
      return;
    }

    if (!shiftHeld) {
      const edge = edgeAt(local.y, view);
      if (edge) {
        edgeDragRef.current = { edge, startBox: { ...line.line_bbox } };
        return;
      }
    }

    // Start an erase stroke (in page coordinates)
    const px = Math.round(view.bbox.x + local.x);
    const py = Math.round(view.bbox.y + local.y);
    const stroke: EraseStroke = {
      id: `s_${Date.now()}_${Math.round(Math.random() * 1e5)}`,
      brush_size: brushSize,
      points: [[px, py]],
    };
    activeStrokeRef.current = stroke;
    mutateLineEdit((le) => ({
      ...le,
      erase_strokes: [...(le.erase_strokes ?? []), stroke],
    }));
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    const { local, view, css } = localFromEvent(e);
    if (!view) return;

    if (panDragRef.current) {
      const p = panDragRef.current;
      setPan({ x: p.startPan.x + (css.x - p.startX), y: p.startPan.y + (css.y - p.startY) });
      return;
    }

    if (edgeDragRef.current && line) {
      const drag = edgeDragRef.current;
      const start = drag.startBox;
      const bottom = start.y + start.h;
      let next: Bbox;
      if (drag.edge === "top") {
        const ny = Math.max(0, Math.min(bottom - 1, Math.round(start.y + local.y - 0)));
        // Re-derive top from absolute page y: start.y + (local.y delta from start top)
        // local.y is relative to the current rendered box's top, which equals start.y.
        // So the new top in page space is start.y + local.y, but local.y is already
        // measured against the current draw — for an active drag we want the
        // pointer's page-y as the new top.
        const pageY = view.bbox.y + local.y;
        const top = Math.max(0, Math.min(bottom - 1, Math.round(pageY)));
        next = { ...start, y: top, h: Math.max(1, bottom - top) };
        void ny;
      } else {
        const pageY = view.bbox.y + local.y;
        const h = Math.max(1, Math.round(pageY - start.y));
        next = { ...start, h };
      }
      setLineBbox(next);
      return;
    }

    if (activeStrokeRef.current) {
      const stroke = activeStrokeRef.current;
      const px = Math.round(view.bbox.x + local.x);
      const py = Math.round(view.bbox.y + local.y);
      const last = stroke.points[stroke.points.length - 1];
      if (!last || Math.hypot(px - last[0], py - last[1]) >= 1) {
        stroke.points.push([px, py]);
        // Mutate edits to trigger re-render
        mutateLineEdit((le) => ({ ...le }));
      }
      return;
    }

    // Idle hover
    const edge = shiftHeld ? null : edgeAt(local.y, view);
    setHoverEdge((prev) => (prev === edge ? prev : edge));
    if (shiftHeld) render(); // for brush cursor
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    activeStrokeRef.current = null;
    edgeDragRef.current = null;
    panDragRef.current = null;
  }

  /* ───────── save / export ───────── */

  async function save() {
    setBusy("saving");
    try {
      const resp = await saveCutEdits(edits);
      applyPayload(resp);
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  }
  async function exportPngs() {
    setBusy("exporting");
    try {
      const saved = await saveCutEdits(edits);
      applyPayload(saved);
      const out = await exportLinePngs();
      alert(`Exported ${out.exported_images} line PNGs to ${out.output_dir}.`);
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  }

  /* ───────── UI ───────── */

  if (loadState.kind === "loading" || loadState.kind === "idle") {
    return (
      <div className="flex h-screen flex-col">
        <AppHeader />
        <div className="flex flex-1 items-center justify-center text-text-muted">
          Loading line-cut data…
        </div>
      </div>
    );
  }
  if (loadState.kind === "error") {
    return (
      <div className="flex h-screen flex-col">
        <AppHeader />
        <div className="m-auto max-w-md rounded border border-error-border bg-error-bg p-4 text-[13px] text-error">
          {loadState.message}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />

      <header className="flex h-[44px] flex-shrink-0 items-center gap-3 border-b border-border bg-white px-4 text-[12.5px]">
        <span className="font-display text-[14px] font-bold text-navy">Finalize · Line cuts</span>
        <div className="ml-2 flex items-center gap-1">
          <button
            type="button"
            disabled={pageIndex <= 0}
            onClick={() => {
              setPageIndex((i) => Math.max(0, i - 1));
              setLineIndex(0);
            }}
            className="h-7 cursor-pointer rounded-sm bg-transparent px-2 text-text-secondary hover:bg-bg-surface disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-text-secondary">
            Page {pageIndex + 1} / {data?.pages.length ?? 0}
          </span>
          <button
            type="button"
            disabled={!data || pageIndex >= data.pages.length - 1}
            onClick={() => {
              setPageIndex((i) => Math.min((data?.pages.length ?? 1) - 1, i + 1));
              setLineIndex(0);
            }}
            className="h-7 cursor-pointer rounded-sm bg-transparent px-2 text-text-secondary hover:bg-bg-surface disabled:opacity-40"
          >
            Next →
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-sm border border-border px-2 py-[2px] text-[11px] text-text-muted">
            {shiftHeld ? "ERASE — release Shift to resize" : "RESIZE — hold Shift to erase"}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={busy !== null}
            className="h-7 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-3 font-semibold text-navy hover:bg-bg-surface disabled:opacity-50"
          >
            {busy === "saving" ? "Saving…" : "Save edits"}
          </button>
          <button
            type="button"
            onClick={exportPngs}
            disabled={busy !== null}
            className="h-7 cursor-pointer rounded-sm bg-navy px-3 font-semibold text-white hover:bg-navy-hover disabled:opacity-50"
          >
            {busy === "exporting" ? "Exporting…" : "Export line PNGs"}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas */}
        <section className="flex flex-1 flex-col bg-bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-white px-3 py-2 text-[12px] text-text-secondary">
            <span className="font-mono text-text-muted">
              {page
                ? `Page ${page.page_number} · ${page.page_image_filename ?? page.image_filename ?? ""}`
                : "no page"}
            </span>

            {/* Tool segmented control */}
            <div className="ml-2 flex overflow-hidden rounded-sm border border-border-strong">
              {(["select", "hand"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTool(t)}
                  title={t === "hand" ? "Hand tool (or hold Space)" : "Select / edit tool"}
                  className={[
                    "h-7 cursor-pointer px-2 text-[11px] font-semibold",
                    effectiveTool === t
                      ? "bg-navy text-white"
                      : "bg-white text-text-secondary hover:bg-bg-surface",
                  ].join(" ")}
                >
                  {t === "select" ? "Select" : "Hand"}
                </button>
              ))}
            </div>

            {/* Background segmented control */}
            <div className="ml-1 flex overflow-hidden rounded-sm border border-border-strong">
              {(
                [
                  { v: "white", label: "White" },
                  { v: "black", label: "Black" },
                  { v: "checker", label: "Grid" },
                  { v: "dots", label: "Dots" },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setBgMode(o.v)}
                  title={`${o.label} background`}
                  className={[
                    "h-7 cursor-pointer px-2 text-[11px] font-semibold",
                    bgMode === o.v
                      ? "bg-navy text-white"
                      : "bg-white text-text-secondary hover:bg-bg-surface",
                  ].join(" ")}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {/* Zoom display + reset */}
            <div className="ml-1 flex items-center gap-1 rounded-sm border border-border-strong bg-white px-2 py-[2px] font-mono text-[11px] text-text-muted">
              <span>{Math.round(zoomMult * 100)}%</span>
              <button
                type="button"
                onClick={() => {
                  setZoomMult(1);
                  setPan({ x: 0, y: 0 });
                }}
                className="ml-1 cursor-pointer text-navy hover:underline"
                title="Reset zoom & pan"
              >
                fit
              </button>
            </div>

            <span className="ml-auto">
              {line ? `Line ${line.line_number} · ${line.type}` : "no line"}
            </span>
            <button
              type="button"
              onClick={() => setLineIndex((i) => Math.max(0, i - 1))}
              disabled={!page || lineIndex <= 0}
              className="h-7 cursor-pointer rounded-sm border border-border-strong bg-white px-2 text-[11px] text-text-secondary hover:bg-bg-surface disabled:opacity-40"
            >
              Prev line
            </button>
            <button
              type="button"
              onClick={() => setLineIndex((i) => Math.min((page?.lines.length ?? 1) - 1, i + 1))}
              disabled={!page || lineIndex >= (page?.lines.length ?? 1) - 1}
              className="h-7 cursor-pointer rounded-sm border border-border-strong bg-white px-2 text-[11px] text-text-secondary hover:bg-bg-surface disabled:opacity-40"
            >
              Next line
            </button>
            <button
              type="button"
              onClick={undoStroke}
              disabled={!currentLineEdit?.erase_strokes?.length}
              className="h-7 cursor-pointer rounded-sm border border-border-strong bg-white px-2 text-[11px] text-text-secondary hover:bg-bg-surface disabled:opacity-40"
            >
              Undo stroke
            </button>
          </div>
          <div className="relative flex-1">
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
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                cursor:
                  effectiveTool === "hand"
                    ? panDragRef.current
                      ? "grabbing"
                      : "grab"
                    : shiftHeld
                      ? "none"
                      : hoverEdge
                        ? "ns-resize"
                        : "crosshair",
              }}
            />
          </div>
        </section>

        {/* Sidebar */}
        <aside className="flex w-[320px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-white">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Pages
          </div>
          <div className="flex max-h-[120px] flex-wrap gap-1 overflow-y-auto border-b border-border bg-bg-surface p-2">
            {data?.pages.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setPageIndex(i);
                  setLineIndex(0);
                }}
                className={[
                  "h-7 cursor-pointer rounded-sm border px-2 text-[11px] font-mono",
                  i === pageIndex
                    ? "border-navy bg-navy text-white"
                    : "border-border-strong bg-white text-text-secondary hover:bg-bg-surface",
                ].join(" ")}
              >
                {String(p.page_number).padStart(3, "0")}
              </button>
            ))}
          </div>

          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Lines
          </div>
          <ul className="flex-1 overflow-y-auto">
            {page?.lines.map((l, i) => {
              const active = i === lineIndex;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setLineIndex(i)}
                    className={[
                      "flex w-full items-center gap-2 border-b border-border px-3 py-[7px] text-left text-[12px]",
                      active ? "bg-orange-tint" : "hover:bg-bg-surface",
                    ].join(" ")}
                  >
                    <span className="w-6 font-mono text-text-muted">{l.line_number}</span>
                    <span className="text-text-secondary">{l.type}</span>
                    <span className="ml-auto font-mono text-[10.5px] text-text-muted">
                      y={l.line_bbox.y} h={l.line_bbox.h}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Crop box editor */}
          <div className="flex-shrink-0 border-t border-border bg-bg-page p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Crop Box (Y / H editable)
            </div>
            {line ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {(["x", "y", "w", "h"] as const).map((k) => (
                    <label key={k} className="flex flex-col gap-[2px]">
                      <span className="text-[10.5px] font-semibold text-text-secondary">
                        {k.toUpperCase()}
                      </span>
                      <input
                        type="number"
                        value={line.line_bbox[k]}
                        disabled={k === "x" || k === "w"}
                        onChange={(e) =>
                          setLineBbox({
                            ...line.line_bbox,
                            [k]: Number(e.target.value) || 0,
                          })
                        }
                        className="h-8 rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-right text-[12px] disabled:bg-bg-surface disabled:text-text-muted"
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLineBbox({ ...line.line_bbox, y: line.line_bbox.y - 1 })}
                    className="h-7 flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface"
                  >
                    Y −
                  </button>
                  <button
                    type="button"
                    onClick={() => setLineBbox({ ...line.line_bbox, y: line.line_bbox.y + 1 })}
                    className="h-7 flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface"
                  >
                    Y +
                  </button>
                  <button
                    type="button"
                    onClick={() => setLineBbox({ ...line.line_bbox, h: line.line_bbox.h - 1 })}
                    className="h-7 flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface"
                  >
                    H −
                  </button>
                  <button
                    type="button"
                    onClick={() => setLineBbox({ ...line.line_bbox, h: line.line_bbox.h + 1 })}
                    className="h-7 flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface"
                  >
                    H +
                  </button>
                </div>
                <button
                  type="button"
                  onClick={resetLineBox}
                  className="mt-2 h-7 w-full cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface"
                >
                  Reset to source
                </button>
              </>
            ) : (
              <p className="text-[12px] text-text-muted">No line selected.</p>
            )}
          </div>

          {/* Eraser */}
          <div className="flex-shrink-0 border-t border-border bg-white p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              <span>Eraser</span>
              <span className="font-normal normal-case">
                {currentLineEdit?.erase_strokes?.length ?? 0} strokes
              </span>
            </div>
            <label className="flex items-center gap-2 text-[11.5px] text-text-secondary">
              Brush
              <input
                type="range"
                min={2}
                max={120}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-10 text-right font-mono text-[11px]">{brushSize}px</span>
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={undoStroke}
                disabled={!currentLineEdit?.erase_strokes?.length}
                className="h-7 flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={clearStrokes}
                disabled={!currentLineEdit?.erase_strokes?.length}
                className="h-7 flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white text-[11px] hover:bg-bg-surface disabled:opacity-40"
              >
                Clear line
              </button>
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-text-muted">
              Hold <b>Shift</b> + drag to erase. Drag the top/bottom edges to adjust Y/H. Width is
              locked to the page crop box.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

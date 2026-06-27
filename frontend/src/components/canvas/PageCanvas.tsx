import { useCallback, useEffect, useRef, useState } from "react";
import type { Rect } from "@/lib/api/types";
import { useSpacePan, type CanvasTool } from "@/hooks/use-space-pan";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";

export type { CanvasTool };

type Props = {
  imageUrl: string | null;
  zoom: number; // multiplier; -1 = "fit"
  onZoomChange?: (z: number) => void;
  drawing: boolean;
  /** Badge label for the crop rect; when null, no rect overlay is drawn. */
  label: string | null;
  rect: Rect | null;
  onRectChange: (rect: Rect | null) => void;
  onCursorChange?: (pos: { x: number; y: number } | null) => void;
  /** Active tool. Defaults to "select". Holding Space temporarily activates "hand". */
  tool?: CanvasTool;
};

type NaturalSize = { w: number; h: number };

type DragMode =
  | { kind: "move"; startRect: Rect; startX: number; startY: number }
  | {
      kind: "resize";
      handle: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
      startRect: Rect;
      startX: number;
      startY: number;
    };

export function PageCanvas({
  imageUrl,
  zoom,
  onZoomChange,
  drawing,
  label,
  rect,
  onRectChange,
  onCursorChange,
  tool = "select",
}: Props) {
  const { scrollRef, effectiveTool, handCursor, containerProps } = useSpacePan({ tool });

  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [drag, setDrag] = useState<DragMode | null>(null);

  useEffect(() => {
    setNatural(null);
  }, [imageUrl]);

  // compute "fit" scale when needed
  useEffect(() => {
    if (zoom !== -1 || !natural || !scrollRef.current) return;
    const el = scrollRef.current;
    const compute = () => {
      const pw = el.clientWidth - 64;
      const ph = el.clientHeight - 64;
      const s = Math.min(pw / natural.w, ph / natural.h, 1);
      setFitScale(s > 0 ? s : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoom, natural, scrollRef]);

  // Auto-initialize a centered rect when target is active and none exists.
  useEffect(() => {
    if (!natural || !label || rect) return;
    const w = Math.round(natural.w * 0.4);
    const h = Math.round(natural.h * 0.25);
    onRectChange({
      x: Math.round((natural.w - w) / 2),
      y: Math.round((natural.h - h) / 2),
      w,
      h,
    });
  }, [natural, label, rect, onRectChange]);

  const scaleNow = zoom === -1 ? fitScale : zoom;

  // Ctrl + wheel zoom
  useCtrlWheelZoom({ ref: scrollRef, zoom: scaleNow, onZoomChange });

  const scale = scaleNow;
  const displayW = natural ? natural.w * scale : 0;
  const displayH = natural ? natural.h * scale : 0;

  // Global pointer move/up so dragging continues outside the rect/handle.
  useEffect(() => {
    if (!drag || !natural || !imgRef.current) return;
    const img = imgRef.current;

    function clientToImage(e: PointerEvent) {
      const r = img.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * natural!.w;
      const y = ((e.clientY - r.top) / r.height) * natural!.h;
      return { x, y };
    }

    function clamp(r: Rect): Rect {
      const nx = Math.max(0, Math.min(natural!.w - 1, r.x));
      const ny = Math.max(0, Math.min(natural!.h - 1, r.y));
      const nw = Math.max(2, Math.min(natural!.w - nx, r.w));
      const nh = Math.max(2, Math.min(natural!.h - ny, r.h));
      return { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
    }

    function onMove(e: PointerEvent) {
      const p = clientToImage(e);
      onCursorChange?.({
        x: Math.max(0, Math.min(natural!.w, Math.round(p.x))),
        y: Math.max(0, Math.min(natural!.h, Math.round(p.y))),
      });

      if (drag!.kind === "move") {
        const dx = p.x - drag!.startX;
        const dy = p.y - drag!.startY;
        const sr = drag!.startRect;
        onRectChange(
          clamp({
            x: Math.max(0, Math.min(natural!.w - sr.w, sr.x + dx)),
            y: Math.max(0, Math.min(natural!.h - sr.h, sr.y + dy)),
            w: sr.w,
            h: sr.h,
          }),
        );
      } else {
        const sr = drag!.startRect;
        let x1 = sr.x;
        let y1 = sr.y;
        let x2 = sr.x + sr.w;
        let y2 = sr.y + sr.h;
        const h = drag!.handle;
        if (h.includes("w")) x1 = p.x;
        if (h.includes("e")) x2 = p.x;
        if (h.includes("n")) y1 = p.y;
        if (h.includes("s")) y2 = p.y;
        const nx = Math.min(x1, x2);
        const ny = Math.min(y1, y2);
        onRectChange(clamp({ x: nx, y: ny, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }));
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
  }, [drag, natural, onRectChange, onCursorChange]);

  function onAreaMouseMove(e: React.MouseEvent) {
    if (!imgRef.current || !natural) return;
    const r = imgRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * natural.w);
    const y = Math.round(((e.clientY - r.top) / r.height) * natural.h);
    onCursorChange?.({
      x: Math.max(0, Math.min(natural.w, x)),
      y: Math.max(0, Math.min(natural.h, y)),
    });
  }

  const startBodyDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!rect || !natural || !imgRef.current) return;
      e.stopPropagation();
      const r = imgRef.current.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * natural.w;
      const y = ((e.clientY - r.top) / r.height) * natural.h;
      setDrag({ kind: "move", startRect: { ...rect }, startX: x, startY: y });
    },
    [rect, natural],
  );

  type HandleKey = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
  const startHandleDrag = useCallback(
    (handle: HandleKey) => (e: React.PointerEvent) => {
      if (!rect || !natural || !imgRef.current) return;
      e.stopPropagation();
      const r = imgRef.current.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * natural.w;
      const y = ((e.clientY - r.top) / r.height) * natural.h;
      setDrag({ kind: "resize", handle, startRect: { ...rect }, startX: x, startY: y });
    },
    [rect, natural],
  );

  return (
    <div
      ref={scrollRef}
      className="raqam-canvas-grid relative flex-1 overflow-auto outline-none"
      {...containerProps}
      style={effectiveTool === "hand" ? { cursor: handCursor } : undefined}
    >
      {imageUrl ? (
        <div
          className="relative mx-auto my-8"
          style={{
            width: displayW || "auto",
            height: displayH || "auto",
            pointerEvents: effectiveTool === "hand" ? "none" : undefined,
          }}
        >
          <div
            className="relative rounded-[4px] border border-border bg-white"
            style={{
              boxShadow: "var(--shadow-page)",
              width: displayW || "auto",
              height: displayH || "auto",
            }}
            onMouseMove={onAreaMouseMove}
            onMouseLeave={() => onCursorChange?.(null)}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt="Page"
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                setNatural({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              style={{
                width: displayW || "auto",
                height: displayH || "auto",
                display: "block",
                userSelect: "none",
              }}
            />
            {rect && natural && label && (
              <RectOverlay
                rect={rect}
                natural={natural}
                label={label}
                onBodyPointerDown={startBodyDrag}
                onHandlePointerDown={startHandleDrag}
                dimming={drawing}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <div className="rounded-md bg-white/80 px-6 py-4 text-[13px] text-text-secondary shadow-[var(--shadow-sm)]">
            Add images using the + tile below to begin.
          </div>
        </div>
      )}
    </div>
  );
}

function RectOverlay({
  rect,
  natural,
  label,
  onBodyPointerDown,
  onHandlePointerDown,
  dimming,
}: {
  rect: Rect;
  natural: NaturalSize;
  label: string;
  onBodyPointerDown: (e: React.PointerEvent) => void;
  onHandlePointerDown: (
    h: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w",
  ) => (e: React.PointerEvent) => void;
  dimming?: boolean;
}) {
  const left = (rect.x / natural.w) * 100;
  const top = (rect.y / natural.h) * 100;
  const width = (rect.w / natural.w) * 100;
  const height = (rect.h / natural.h) * 100;

  const edgeHandles: Array<{
    key: "n" | "s" | "e" | "w";
    style: React.CSSProperties;
    cursor: string;
  }> = [
    {
      key: "n",
      style: { top: -3, left: "2%", right: "2%", height: 6 },
      cursor: "ns-resize",
    },
    {
      key: "s",
      style: { bottom: -3, left: "2%", right: "2%", height: 6 },
      cursor: "ns-resize",
    },
    {
      key: "e",
      style: { right: -3, top: "2%", bottom: "2%", width: 6 },
      cursor: "ew-resize",
    },
    {
      key: "w",
      style: { left: -3, top: "2%", bottom: "2%", width: 6 },
      cursor: "ew-resize",
    },
  ];

  const cornerHandles: Array<{
    key: "nw" | "ne" | "sw" | "se";
    pos: React.CSSProperties;
    cursor: string;
  }> = [
    { key: "nw", pos: { left: -6, top: -6 }, cursor: "nwse-resize" },
    { key: "ne", pos: { right: -6, top: -6 }, cursor: "nesw-resize" },
    { key: "sw", pos: { left: -6, bottom: -6 }, cursor: "nesw-resize" },
    { key: "se", pos: { right: -6, bottom: -6 }, cursor: "nwse-resize" },
  ];

  return (
    <>
      {/* Optional dim outside (kept subtle) */}
      {dimming && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "color-mix(in oklab, var(--navy) 10%, transparent)",
            clipPath: `polygon(0% 0%, 0% 100%, ${left}% 100%, ${left}% ${top}%, ${left + width}% ${top}%, ${left + width}% ${top + height}%, ${left}% ${top + height}%, ${left}% 100%, 100% 100%, 100% 0%)`,
          }}
        />
      )}

      {/* main rect */}
      <div
        onPointerDown={onBodyPointerDown}
        className="absolute rounded-[3px] border-2 border-orange"
        style={{
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          height: `${height}%`,
          backgroundColor: "color-mix(in oklab, var(--orange) 4%, transparent)",
          cursor: "move",
          touchAction: "none",
        }}
      >
        {/* edge handles */}
        {edgeHandles.map((h) => (
          <div
            key={h.key}
            onPointerDown={onHandlePointerDown(h.key)}
            className="absolute"
            style={{ ...h.style, cursor: h.cursor, touchAction: "none" }}
          />
        ))}
        {/* corner handles */}
        {cornerHandles.map((h) => (
          <div
            key={h.key}
            onPointerDown={onHandlePointerDown(h.key)}
            className="absolute h-[12px] w-[12px] rounded-[3px] border-2 border-orange bg-white"
            style={{ ...h.pos, cursor: h.cursor, touchAction: "none" }}
          />
        ))}
        {/* label badge */}
        <div
          className="pointer-events-none absolute rounded-pill bg-orange px-2 py-[2px] text-[10px] font-semibold text-white"
          style={{
            top: "-22px",
            left: "0px",
            letterSpacing: "0.04em",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
        {/* dimension tag */}
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-[3px] bg-navy px-[7px] py-[2px] text-[10px] font-medium text-white"
          style={{
            bottom: "-22px",
            left: "50%",
            whiteSpace: "nowrap",
          }}
        >
          {Math.round(rect.w)} × {Math.round(rect.h)} px
        </div>
      </div>
    </>
  );
}

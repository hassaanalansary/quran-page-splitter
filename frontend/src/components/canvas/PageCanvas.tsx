import { Lock, LockOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Rect } from "@/lib/api/types";
import { useSpacePan, type CanvasTool } from "@/hooks/use-space-pan";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { useZoomToPointer } from "@/hooks/use-zoom-to-pointer";

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
  /** Reports the page image's natural size once loaded. */
  onNatural?: (n: { w: number; h: number }) => void;
  /** Active tool. Defaults to "select". Holding Space temporarily activates "hand". */
  tool?: CanvasTool;
  /**
   * When true, the crop rect is shown mirrored across the page's vertical
   * centerline and made read-only — a preview of how the alternate-margin
   * engine crops this page. Editing happens on non-mirrored pages.
   */
  mirrored?: boolean;
  /** Freezes the crop rect (no drag, no resize handles) while keeping it visible. */
  locked?: boolean;
  /** When given, the rect's badge carries a lock toggle. */
  onToggleLock?: () => void;
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
  onNatural,
  tool = "select",
  mirrored = false,
  locked = false,
  onToggleLock,
}: Props) {
  const { t } = useTranslation();
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
    if (!natural || !label || rect || locked) return;
    const w = Math.round(natural.w * 0.4);
    const h = Math.round(natural.h * 0.25);
    onRectChange({
      x: Math.round((natural.w - w) / 2),
      y: Math.round((natural.h - h) / 2),
      w,
      h,
    });
  }, [natural, label, rect, locked, onRectChange]);

  const scaleNow = zoom === -1 ? fitScale : zoom;

  // Ctrl + wheel zoom
  useCtrlWheelZoom({ ref: scrollRef, zoom: scaleNow, onZoomChange });
  useZoomToPointer({ scrollRef, imgRef, scale: scaleNow, enabled: zoom !== -1 });

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
              alt={t("canvas.page")}
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth > 0) {
                  const n = { w: el.naturalWidth, h: el.naturalHeight };
                  setNatural(n);
                  onNatural?.(n);
                }
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
                rect={
                  mirrored
                    ? { x: natural.w - (rect.x + rect.w), y: rect.y, w: rect.w, h: rect.h }
                    : rect
                }
                natural={natural}
                label={label}
                onBodyPointerDown={mirrored || locked ? undefined : startBodyDrag}
                onHandlePointerDown={mirrored || locked ? undefined : startHandleDrag}
                dimming={drawing}
                mirrored={mirrored}
                locked={locked}
                onToggleLock={mirrored ? undefined : onToggleLock}
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
  onToggleLock,
  dimming,
  mirrored = false,
  locked = false,
}: {
  rect: Rect;
  natural: NaturalSize;
  label: string;
  onBodyPointerDown?: (e: React.PointerEvent) => void;
  onHandlePointerDown?: (
    h: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w",
  ) => (e: React.PointerEvent) => void;
  dimming?: boolean;
  /** Read-only preview of the mirrored (alternate-margin) crop. */
  mirrored?: boolean;
  /** Frozen by the user — same colours as usual, but no drag and no handles. */
  locked?: boolean;
  /** Adds a lock toggle to the badge; the badge stays click-through without it. */
  onToggleLock?: () => void;
}) {
  const { t } = useTranslation();
  const frozen = mirrored || locked;
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
        onPointerDown={frozen ? undefined : onBodyPointerDown}
        className="absolute rounded-[3px] border-2"
        style={{
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          height: `${height}%`,
          borderColor: mirrored ? "var(--navy)" : "var(--orange)",
          borderStyle: frozen ? "dashed" : "solid",
          backgroundColor: mirrored
            ? "color-mix(in oklab, var(--navy) 6%, transparent)"
            : "color-mix(in oklab, var(--orange) 4%, transparent)",
          cursor: frozen ? "default" : "move",
          pointerEvents: frozen ? "none" : undefined,
          touchAction: "none",
        }}
      >
        {/* resize handles — hidden while the rect is read-only (mirrored / locked) */}
        {!frozen && onHandlePointerDown && (
          <>
            {edgeHandles.map((h) => (
              <div
                key={h.key}
                onPointerDown={onHandlePointerDown(h.key)}
                className="absolute"
                style={{ ...h.style, cursor: h.cursor, touchAction: "none" }}
              />
            ))}
            {cornerHandles.map((h) => (
              <div
                key={h.key}
                onPointerDown={onHandlePointerDown(h.key)}
                className="absolute h-[12px] w-[12px] rounded-[3px] border-2 border-orange bg-white"
                style={{ ...h.pos, cursor: h.cursor, touchAction: "none" }}
              />
            ))}
          </>
        )}
        {/* label badge — carries the lock toggle, so freezing the box needs no
            panel space and sits where the user is already looking */}
        <div
          className="pointer-events-none absolute inline-flex items-center gap-1 rounded-pill py-[2px] ps-2 pe-2 text-[10px] font-semibold text-white"
          style={{
            top: "-22px",
            left: "0px",
            letterSpacing: "0.04em",
            whiteSpace: "nowrap",
            background: mirrored ? "var(--navy)" : "var(--orange)",
          }}
        >
          <span>
            {mirrored
              ? `⇄ ${label} · ${t("canvas.mirrored")}`
              : locked
                ? `${label} · ${t("canvas.locked")}`
                : label}
          </span>
          {onToggleLock && (
            <button
              type="button"
              aria-pressed={locked}
              aria-label={locked ? t("process.unlockBounds") : t("process.lockBounds")}
              title={`${locked ? t("process.unlockBounds") : t("process.lockBounds")} — ${t("process.lockHint")}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onToggleLock}
              className="pointer-events-auto -me-1 flex h-[17px] w-[17px] cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              {locked ? <Lock size={10} strokeWidth={2.75} /> : <LockOpen size={10} />}
            </button>
          )}
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

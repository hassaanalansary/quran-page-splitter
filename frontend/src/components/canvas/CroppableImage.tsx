import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Rect } from "@/lib/api/types";

type NaturalSize = { w: number; h: number };

type HandleKey = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type DragMode =
  | { kind: "move"; startRect: Rect; startX: number; startY: number }
  | { kind: "resize"; handle: HandleKey; startRect: Rect; startX: number; startY: number };

type Props = {
  imageUrl: string;
  /** Crop rectangle in natural image pixels (controlled). */
  rect: Rect | null;
  onRectChange: (r: Rect | null) => void;
  label: string;
  /** Reports the image's natural size once loaded (e.g. to size a filmstrip slot). */
  onNatural?: (n: NaturalSize) => void;
};

/**
 * An image that fills its container with a single draggable/resizable crop
 * rectangle on top, expressed in natural image pixels. Pointer math uses the
 * image's live bounding rect, so it needs no layout measurement and works inside
 * a (possibly transformed) filmstrip slot. Magnification is left to a preview pane.
 */
export function CroppableImage({ imageUrl, rect, onRectChange, label, onNatural }: Props) {
  const { t } = useTranslation();
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);

  useEffect(() => setNatural(null), [imageUrl]);

  // Auto-place a centred rectangle when none exists yet.
  useEffect(() => {
    if (!natural || rect) return;
    const w = Math.round(natural.w * 0.4);
    const h = Math.round(natural.h * 0.25);
    onRectChange({ x: Math.round((natural.w - w) / 2), y: Math.round((natural.h - h) / 2), w, h });
  }, [natural, rect, onRectChange]);

  // Global drag handling so the pointer can leave the rect/handle mid-drag.
  useEffect(() => {
    if (!drag || !natural || !imgRef.current) return;
    const img = imgRef.current;

    const toImage = (e: PointerEvent) => {
      const r = img.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * natural.w,
        y: ((e.clientY - r.top) / r.height) * natural.h,
      };
    };
    const clamp = (r: Rect): Rect => {
      const nx = Math.max(0, Math.min(natural.w - 1, r.x));
      const ny = Math.max(0, Math.min(natural.h - 1, r.y));
      return {
        x: Math.round(nx),
        y: Math.round(ny),
        w: Math.round(Math.max(2, Math.min(natural.w - nx, r.w))),
        h: Math.round(Math.max(2, Math.min(natural.h - ny, r.h))),
      };
    };

    const onMove = (e: PointerEvent) => {
      const p = toImage(e);
      if (drag.kind === "move") {
        const sr = drag.startRect;
        onRectChange(
          clamp({
            x: Math.max(0, Math.min(natural.w - sr.w, sr.x + (p.x - drag.startX))),
            y: Math.max(0, Math.min(natural.h - sr.h, sr.y + (p.y - drag.startY))),
            w: sr.w,
            h: sr.h,
          }),
        );
      } else {
        const sr = drag.startRect;
        let [x1, y1, x2, y2] = [sr.x, sr.y, sr.x + sr.w, sr.y + sr.h];
        const h = drag.handle;
        if (h.includes("w")) x1 = p.x;
        if (h.includes("e")) x2 = p.x;
        if (h.includes("n")) y1 = p.y;
        if (h.includes("s")) y2 = p.y;
        onRectChange(
          clamp({
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            w: Math.abs(x2 - x1),
            h: Math.abs(y2 - y1),
          }),
        );
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, natural, onRectChange]);

  const startBody = useCallback(
    (e: React.PointerEvent) => {
      if (!rect || !natural || !imgRef.current) return;
      e.stopPropagation();
      const r = imgRef.current.getBoundingClientRect();
      setDrag({
        kind: "move",
        startRect: { ...rect },
        startX: ((e.clientX - r.left) / r.width) * natural.w,
        startY: ((e.clientY - r.top) / r.height) * natural.h,
      });
    },
    [rect, natural],
  );

  const startHandle = useCallback(
    (handle: HandleKey) => (e: React.PointerEvent) => {
      if (!rect || !natural || !imgRef.current) return;
      e.stopPropagation();
      const r = imgRef.current.getBoundingClientRect();
      setDrag({
        kind: "resize",
        handle,
        startRect: { ...rect },
        startX: ((e.clientX - r.left) / r.width) * natural.w,
        startY: ((e.clientY - r.top) / r.height) * natural.h,
      });
    },
    [rect, natural],
  );

  return (
    <div className="relative h-full w-full">
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
        className="h-full w-full select-none object-contain"
      />
      {rect && natural && (
        <RectOverlay
          rect={rect}
          natural={natural}
          label={label}
          onBodyPointerDown={startBody}
          onHandlePointerDown={startHandle}
        />
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
}: {
  rect: Rect;
  natural: NaturalSize;
  label: string;
  onBodyPointerDown: (e: React.PointerEvent) => void;
  onHandlePointerDown: (h: HandleKey) => (e: React.PointerEvent) => void;
}) {
  const left = (rect.x / natural.w) * 100;
  const top = (rect.y / natural.h) * 100;
  const width = (rect.w / natural.w) * 100;
  const height = (rect.h / natural.h) * 100;

  const edges: { key: "n" | "s" | "e" | "w"; style: React.CSSProperties; cursor: string }[] = [
    { key: "n", style: { top: -3, left: "2%", right: "2%", height: 6 }, cursor: "ns-resize" },
    { key: "s", style: { bottom: -3, left: "2%", right: "2%", height: 6 }, cursor: "ns-resize" },
    { key: "e", style: { right: -3, top: "2%", bottom: "2%", width: 6 }, cursor: "ew-resize" },
    { key: "w", style: { left: -3, top: "2%", bottom: "2%", width: 6 }, cursor: "ew-resize" },
  ];
  const corners: { key: "nw" | "ne" | "sw" | "se"; pos: React.CSSProperties; cursor: string }[] = [
    { key: "nw", pos: { left: -6, top: -6 }, cursor: "nwse-resize" },
    { key: "ne", pos: { right: -6, top: -6 }, cursor: "nesw-resize" },
    { key: "sw", pos: { left: -6, bottom: -6 }, cursor: "nesw-resize" },
    { key: "se", pos: { right: -6, bottom: -6 }, cursor: "nwse-resize" },
  ];

  return (
    <>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "color-mix(in oklab, var(--navy) 10%, transparent)",
          clipPath: `polygon(0% 0%, 0% 100%, ${left}% 100%, ${left}% ${top}%, ${left + width}% ${top}%, ${left + width}% ${top + height}%, ${left}% ${top + height}%, ${left}% 100%, 100% 100%, 100% 0%)`,
        }}
      />
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
        {edges.map((h) => (
          <div
            key={h.key}
            onPointerDown={onHandlePointerDown(h.key)}
            className="absolute"
            style={{ ...h.style, cursor: h.cursor, touchAction: "none" }}
          />
        ))}
        {corners.map((h) => (
          <div
            key={h.key}
            onPointerDown={onHandlePointerDown(h.key)}
            className="absolute h-[12px] w-[12px] rounded-[3px] border-2 border-orange bg-white"
            style={{ ...h.pos, cursor: h.cursor, touchAction: "none" }}
          />
        ))}
        <div
          className="pointer-events-none absolute rounded-pill bg-orange px-2 py-[2px] text-[10px] font-semibold text-white"
          style={{ top: -22, left: 0, letterSpacing: "0.04em", whiteSpace: "nowrap" }}
        >
          {label}
        </div>
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-[3px] bg-navy px-[7px] py-[2px] text-[10px] font-medium text-white"
          style={{ bottom: -22, left: "50%", whiteSpace: "nowrap" }}
        >
          {Math.round(rect.w)} × {Math.round(rect.h)} px
        </div>
      </div>
    </>
  );
}

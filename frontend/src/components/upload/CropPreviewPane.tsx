import { useEffect, useRef, useState } from "react";
import type { Rect, TargetName } from "@/lib/api/raqam";

type Props = {
  imageUrl: string | null;
  rect: Rect | null;
  activeTarget: TargetName | null;
  /** When set, show this captured image instead of the live page crop. */
  capturedUrl?: string | null;
  /** Optional filename shown in the footer when a captured image is displayed. */
  capturedSourceName?: string | null;
};

export function CropPreviewPane({
  imageUrl,
  rect,
  activeTarget,
  capturedUrl,
  capturedSourceName,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [capturedNatural, setCapturedNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setNatural(null);
    if (!imageUrl) return;
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    setCapturedNatural(null);
    if (!capturedUrl) return;
    const img = new Image();
    img.onload = () => setCapturedNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = capturedUrl;
  }, [capturedUrl]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padding = 24;
  const innerW = Math.max(0, box.w - padding * 2);
  const innerH = Math.max(0, box.h - padding * 2);

  // Mode 1: show captured template image (page-independent snapshot).
  const showCaptured = !!capturedUrl && !!capturedNatural;

  // Mode 2: live page crop based on rect.
  const showLive =
    !showCaptured && !!imageUrl && !!rect && !!natural && rect.w > 1 && rect.h > 1;

  let dispW = 0;
  let dispH = 0;
  let scale = 1;
  if (showCaptured) {
    scale = Math.min(innerW / capturedNatural!.w, innerH / capturedNatural!.h);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    dispW = capturedNatural!.w * scale;
    dispH = capturedNatural!.h * scale;
  } else if (showLive) {
    scale = Math.min(innerW / rect!.w, innerH / rect!.h);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    dispW = rect!.w * scale;
    dispH = rect!.h * scale;
  }

  return (
    <aside
      className="hidden w-[34%] min-w-[280px] max-w-[520px] flex-shrink-0 flex-col border-l border-border bg-white lg:flex"
    >
      <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-border bg-white px-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
            {showCaptured ? "Captured Template" : "Live Crop Preview"}
          </span>
        </div>
        {activeTarget && (
          <span className="rounded-pill bg-orange-tint px-2 py-[2px] text-[10.5px] font-semibold uppercase tracking-wider text-orange">
            {activeTarget}
          </span>
        )}
      </div>

      <div
        ref={wrapRef}
        className="raqam-canvas-grid relative flex flex-1 items-center justify-center overflow-hidden p-6"
      >
        {showCaptured ? (
          <img
            src={capturedUrl!}
            alt="Captured template"
            className="rounded-[4px] border border-border bg-white"
            style={{
              width: dispW,
              height: dispH,
              boxShadow: "var(--shadow-md)",
            }}
            draggable={false}
          />
        ) : showLive ? (
          <div
            className="rounded-[4px] border border-border bg-white"
            style={{
              width: dispW,
              height: dispH,
              boxShadow: "var(--shadow-md)",
              backgroundImage: `url(${imageUrl})`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${natural!.w * scale}px ${natural!.h * scale}px`,
              backgroundPosition: `-${rect!.x * scale}px -${rect!.y * scale}px`,
            }}
          />
        ) : (
          <div className="max-w-[220px] text-center text-[12.5px] leading-relaxed text-text-muted">
            {imageUrl
              ? "Select a target and adjust the crop rectangle to see a live preview here."
              : "Load a page to preview crops."}
          </div>
        )}
      </div>

      <div className="flex h-8 flex-shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-surface px-3 text-[11px] text-text-muted">
        {showCaptured ? (
          <>
            <span className="truncate font-mono text-text-secondary">
              {capturedSourceName ? `from ${capturedSourceName}` : "captured"}
            </span>
            <span className="font-mono font-medium text-text-secondary">
              {capturedNatural!.w} × {capturedNatural!.h} px
            </span>
          </>
        ) : rect ? (
          <>
            <span className="font-mono">
              x {Math.round(rect.x)} · y {Math.round(rect.y)}
            </span>
            <span className="font-mono font-medium text-text-secondary">
              {Math.round(rect.w)} × {Math.round(rect.h)} px
            </span>
            <span className="font-mono">{Math.round(scale * 100)}%</span>
          </>
        ) : (
          <span className="font-mono">—</span>
        )}
      </div>
    </aside>
  );
}

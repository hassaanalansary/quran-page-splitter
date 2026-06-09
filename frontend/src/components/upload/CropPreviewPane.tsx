import { useEffect, useRef, useState } from "react";
import type { Rect, TargetName } from "@/lib/api/raqam";

type IgnoreContext = {
  parentTemplateUrl: string | null;
  parentRect: Rect | null;
  parentName: TargetName;
  parentSourceName?: string | null;
  /** Already-saved ignore rect (relative to the parent template). When present,
   *  the bottom pane shows this cut instead of the live selection. */
  savedIgnoreRect?: Rect | null;
};

type Props = {
  imageUrl: string | null;
  rect: Rect | null;
  activeTarget: TargetName | null;
  /** When set, show this captured image instead of the live page crop. */
  capturedUrl?: string | null;
  /** Optional filename shown in the footer when a captured image is displayed. */
  capturedSourceName?: string | null;
  /** When set, render ignore-mode (stacked: live selection over template+overlay). */
  ignore?: IgnoreContext | null;
};

function useNaturalSize(url: string | null | undefined) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    setSize(null);
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, [url]);
  return size;
}

function useBox(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

export function CropPreviewPane({
  imageUrl,
  rect,
  activeTarget,
  capturedUrl,
  capturedSourceName,
  ignore,
}: Props) {
  const isIgnore = !!ignore;

  return (
    <aside className="hidden w-[34%] min-w-[280px] max-w-[520px] flex-shrink-0 flex-col border-l border-border bg-white lg:flex">
      <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-border bg-white px-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
            {isIgnore
              ? "Ignore Preview"
              : capturedUrl
                ? "Captured Template"
                : "Live Crop Preview"}
          </span>
        </div>
        {activeTarget && (
          <span className="rounded-pill bg-orange-tint px-2 py-[2px] text-[10.5px] font-semibold uppercase tracking-wider text-orange">
            {activeTarget}
          </span>
        )}
      </div>

      {isIgnore ? (
        <IgnoreStacked
          imageUrl={imageUrl}
          rect={rect}
          ignore={ignore!}
        />
      ) : (
        <SinglePreview
          imageUrl={imageUrl}
          rect={rect}
          capturedUrl={capturedUrl ?? null}
          capturedSourceName={capturedSourceName ?? null}
        />
      )}
    </aside>
  );
}

/* ────────────────────────── default (non-ignore) preview ───────────────────────── */

function SinglePreview({
  imageUrl,
  rect,
  capturedUrl,
  capturedSourceName,
}: {
  imageUrl: string | null;
  rect: Rect | null;
  capturedUrl: string | null;
  capturedSourceName: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const box = useBox(wrapRef);
  const natural = useNaturalSize(imageUrl);
  const capturedNatural = useNaturalSize(capturedUrl);

  const padding = 24;
  const innerW = Math.max(0, box.w - padding * 2);
  const innerH = Math.max(0, box.h - padding * 2);

  const showCaptured = !!capturedUrl && !!capturedNatural;
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
    <>
      <div
        ref={wrapRef}
        className="raqam-canvas-grid relative flex flex-1 items-center justify-center overflow-hidden p-6"
      >
        {showCaptured ? (
          <img
            src={capturedUrl!}
            alt="Captured template"
            className="rounded-[4px] border border-border bg-white"
            style={{ width: dispW, height: dispH, boxShadow: "var(--shadow-md)" }}
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
    </>
  );
}

/* ─────────────────────────── ignore-mode stacked preview ───────────────────────── */

function IgnoreStacked({
  imageUrl,
  rect,
  ignore,
}: {
  imageUrl: string | null;
  rect: Rect | null;
  ignore: IgnoreContext;
}) {
  const { parentTemplateUrl, parentRect, parentName, parentSourceName, savedIgnoreRect } =
    ignore;
  const pageNatural = useNaturalSize(imageUrl);
  const tmplNatural = useNaturalSize(parentTemplateUrl);

  // Decide which relative rect to overlay on the template:
  // prefer the already-saved cut; fall back to the live selection.
  const relRect: Rect | null =
    savedIgnoreRect && tmplNatural
      ? savedIgnoreRect
      : rect && parentRect && tmplNatural
        ? {
            x: Math.round(rect.x - parentRect.x),
            y: Math.round(rect.y - parentRect.y),
            w: Math.round(rect.w),
            h: Math.round(rect.h),
          }
        : null;

  const usingSaved = !!savedIgnoreRect;

  const relInside =
    !!relRect &&
    !!tmplNatural &&
    relRect.x >= 0 &&
    relRect.y >= 0 &&
    relRect.x + relRect.w <= tmplNatural.w &&
    relRect.y + relRect.h <= tmplNatural.h;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* TOP — live selection from the current page */}
      <div className="flex flex-1 flex-col overflow-hidden border-b border-border">
        <div className="flex h-6 flex-shrink-0 items-center justify-between border-b border-border bg-bg-surface px-3 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
          <span>Live Selection</span>
          {rect && (
            <span className="font-mono font-normal text-text-secondary">
              {Math.round(rect.w)} × {Math.round(rect.h)} px
            </span>
          )}
        </div>
        <LiveCrop imageUrl={imageUrl} rect={rect} natural={pageNatural} />
      </div>

      {/* BOTTOM — parent template with ignore overlay */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-6 flex-shrink-0 items-center justify-between border-b border-border bg-bg-surface px-3 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
          <span>
            {parentName} · {usingSaved ? "saved ignore" : "ignored area"}
          </span>
          {parentSourceName && (
            <span className="truncate font-mono font-normal text-text-secondary">
              from {parentSourceName}
            </span>
          )}
        </div>
        <TemplateWithOverlay
          templateUrl={parentTemplateUrl}
          templateNatural={tmplNatural}
          relRect={relInside ? relRect : null}
          invalid={!!relRect && !relInside}
          missing={!parentTemplateUrl}
        />
      </div>
    </div>
  );
}

function LiveCrop({
  imageUrl,
  rect,
  natural,
}: {
  imageUrl: string | null;
  rect: Rect | null;
  natural: { w: number; h: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useBox(ref);
  const padding = 16;
  const innerW = Math.max(0, box.w - padding * 2);
  const innerH = Math.max(0, box.h - padding * 2);
  const ok = !!imageUrl && !!rect && !!natural && rect.w > 1 && rect.h > 1;
  let scale = 1;
  let dispW = 0;
  let dispH = 0;
  if (ok) {
    scale = Math.min(innerW / rect!.w, innerH / rect!.h);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    dispW = rect!.w * scale;
    dispH = rect!.h * scale;
  }
  return (
    <div
      ref={ref}
      className="raqam-canvas-grid relative flex flex-1 items-center justify-center overflow-hidden p-4"
    >
      {ok ? (
        <div
          className="rounded-[3px] border border-border bg-white"
          style={{
            width: dispW,
            height: dispH,
            boxShadow: "var(--shadow-sm)",
            backgroundImage: `url(${imageUrl})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${natural!.w * scale}px ${natural!.h * scale}px`,
            backgroundPosition: `-${rect!.x * scale}px -${rect!.y * scale}px`,
          }}
        />
      ) : (
        <span className="text-[11.5px] text-text-muted">
          Adjust the rectangle to preview the selection.
        </span>
      )}
    </div>
  );
}

function TemplateWithOverlay({
  templateUrl,
  templateNatural,
  relRect,
  invalid,
  missing,
}: {
  templateUrl: string | null;
  templateNatural: { w: number; h: number } | null;
  relRect: Rect | null;
  invalid: boolean;
  missing: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useBox(ref);
  const padding = 16;
  const innerW = Math.max(0, box.w - padding * 2);
  const innerH = Math.max(0, box.h - padding * 2);
  const ok = !!templateUrl && !!templateNatural;
  let scale = 1;
  let dispW = 0;
  let dispH = 0;
  if (ok) {
    scale = Math.min(innerW / templateNatural!.w, innerH / templateNatural!.h);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    dispW = templateNatural!.w * scale;
    dispH = templateNatural!.h * scale;
  }
  return (
    <div
      ref={ref}
      className="raqam-canvas-grid relative flex flex-1 items-center justify-center overflow-hidden p-4"
    >
      {missing ? (
        <span className="max-w-[220px] text-center text-[11.5px] leading-relaxed text-text-muted">
          Apply the parent template first — the ignore region is shown relative to it.
        </span>
      ) : ok ? (
        <div
          className="relative rounded-[3px] border border-border bg-white"
          style={{ width: dispW, height: dispH, boxShadow: "var(--shadow-sm)" }}
        >
          <img
            src={templateUrl!}
            alt="Parent template"
            draggable={false}
            style={{ width: dispW, height: dispH, display: "block", userSelect: "none" }}
          />
          {relRect && (
            <div
              className="pointer-events-none absolute border-2 border-error"
              style={{
                left: relRect.x * scale,
                top: relRect.y * scale,
                width: relRect.w * scale,
                height: relRect.h * scale,
                backgroundColor:
                  "color-mix(in oklab, var(--error) 22%, transparent)",
                boxShadow:
                  "0 0 0 1px color-mix(in oklab, var(--error) 35%, transparent)",
              }}
            />
          )}
          {invalid && (
            <div className="pointer-events-none absolute inset-x-0 bottom-1 mx-auto w-fit rounded-pill bg-error px-2 py-[2px] text-[10px] font-semibold uppercase tracking-wider text-white">
              Outside template
            </div>
          )}
        </div>
      ) : (
        <span className="text-[11.5px] text-text-muted">No template loaded.</span>
      )}
    </div>
  );
}

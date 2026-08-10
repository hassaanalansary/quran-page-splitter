import { Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { useZoomToPointer } from "@/hooks/use-zoom-to-pointer";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const STEP = 1.5;
/** Breathing room around the content, so the badges a child draws just outside
 * the image (labels, size tags) still have somewhere to go. */
const PAD = 16;
/** What "fit" gives up on top of the padding: enough for a scrollbar plus a
 * couple of pixels of slack. Measuring the border box and reserving this makes
 * the fit scale independent of whether a scrollbar is currently showing —
 * otherwise one appearing shrinks the fit, which can hide it again, and so on. */
const INSET = 2 * PAD + 18;

type Props = {
  /** The image the box is sized from — only its natural size is read here. */
  imageUrl: string;
  /** Pane height in px. */
  height: number;
  /** Rendered inside the sized box; give it `h-full w-full`. */
  children: ReactNode;
};

/**
 * A panel-sized scroll-and-zoom box for previews too small to work in at their
 * natural size. Zoom is a multiple of "fit" (1× = the whole image visible)
 * rather than an absolute percentage, because what goes in here is a template
 * crop that can be a few dozen pixels wide — an absolute 100% would be a zoom
 * *out*.
 *
 * Ctrl + wheel zooms around the pointer and the buttons step it. Panning is the
 * container's own scrollbars, which leaves dragging free for whatever overlay
 * the child draws.
 */
export function ZoomPane({ imageUrl, height, children }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(MIN_ZOOM);

  // The child paints the same URL, so this second load is a cache hit; it just
  // gives the box its aspect ratio before the child has anything to report.
  useEffect(() => {
    setNatural(null);
    setZoom(MIN_ZOOM);
    const im = new Image();
    im.onload = () => setNatural({ w: im.naturalWidth, h: im.naturalHeight });
    im.src = imageUrl;
  }, [imageUrl]);

  // "Fit" tracks the pane's own size, so a resized panel keeps 1× meaning
  // "everything visible".
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !natural) return;
    const compute = () => {
      const s = Math.min(
        (el.offsetWidth - INSET) / natural.w,
        (el.offsetHeight - INSET) / natural.h,
      );
      setFit(s > 0 ? s : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural]);

  const scale = fit * zoom;
  useCtrlWheelZoom({ ref: scrollRef, zoom, onZoomChange: setZoom, min: MIN_ZOOM, max: MAX_ZOOM });
  useZoomToPointer({ scrollRef, imgRef: boxRef, scale });

  const step = (factor: number) =>
    setZoom((z) => Number(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)).toFixed(3)));

  const w = natural ? natural.w * scale : null;
  const h = natural ? natural.h * scale : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <ZoomButton
          label={t("canvas.zoomOut")}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => step(1 / STEP)}
        >
          <Minus size={12} />
        </ZoomButton>
        <span className="w-10 text-center text-[10.5px] font-medium tabular-nums text-text-secondary">
          {Math.round(zoom * 100)}%
        </span>
        <ZoomButton
          label={t("canvas.zoomIn")}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => step(STEP)}
        >
          <Plus size={12} />
        </ZoomButton>
        <ZoomButton
          label={t("canvas.fit")}
          disabled={zoom === MIN_ZOOM}
          onClick={() => setZoom(MIN_ZOOM)}
        >
          <Maximize2 size={11} />
        </ZoomButton>
        <span className="ms-auto text-[10px] text-text-muted">{t("canvas.zoomHint")}</span>
      </div>
      <div
        ref={scrollRef}
        className="raqam-canvas-grid overflow-auto rounded-md border border-border"
        style={{ height }}
      >
        {/* `max-content` + `min-*: 100%`: centres the box while it is smaller
            than the pane, and stops centring from putting the start edge out of
            scroll reach once it is bigger. */}
        <div
          className="flex items-center justify-center"
          style={{
            width: w ? "max-content" : "100%",
            height: h ? "max-content" : "100%",
            minWidth: "100%",
            minHeight: "100%",
            padding: PAD,
          }}
        >
          <div
            ref={boxRef}
            className="relative flex-none"
            style={{
              width: w ?? "100%",
              height: h ?? "100%",
              // Inherited by the child image; magnifying a template is about
              // seeing where its ink actually ends, not a smooth blur.
              imageRendering: scale > 1 ? "pixelated" : undefined,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-sm border border-border-strong bg-white text-text-secondary transition-colors hover:bg-bg-surface disabled:cursor-default disabled:opacity-40 disabled:hover:bg-white"
    >
      {children}
    </button>
  );
}

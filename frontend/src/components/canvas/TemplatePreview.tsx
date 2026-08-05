import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CropPreview } from "@/components/canvas/CropPreview";
import type { Rect } from "@/lib/api/types";

type Props =
  | { mode: "bounds"; pageUrl: string; working: Rect | null; mirrored?: boolean }
  | { mode: "template"; pageUrl: string; working: Rect | null }
  | {
      mode: "ignore";
      pageUrl: string;
      working: Rect | null;
      parentLabel: string;
      /** Captured/fetched parent template image (null when the parent isn't set). */
      parentImageUrl: string | null;
      /** Ignore rect relative to the parent template image (px), or null. */
      ignoreRelative: Rect | null;
    };

/**
 * The large center preview for the Templates step. In template mode it magnifies
 * the current selection; in ignore mode it shows the live selection plus the
 * captured parent template with the ignored area drawn as a red box (and a
 * validation message when the parent template isn't set yet).
 */
export function TemplatePreview(props: Props) {
  const { t } = useTranslation();
  if (props.mode === "template") {
    return (
      <div className="flex flex-1 flex-col gap-2 overflow-auto">
        <Header title={t("canvas.tpl_cropPreview")} />
        <CropPreview imageUrl={props.pageUrl} rect={props.working} height={340} />
      </div>
    );
  }

  if (props.mode === "bounds") {
    return (
      <div className="flex flex-1 flex-col gap-2 overflow-auto">
        <Header title={t("canvas.tpl_boundsPreview")} />
        <CropPreview
          imageUrl={props.pageUrl}
          rect={props.working}
          height={340}
          mirrored={props.mirrored}
          caption={props.mirrored ? t("canvas.tpl_mirroredCaption") : undefined}
        />
      </div>
    );
  }

  const { pageUrl, working, parentLabel, parentImageUrl, ignoreRelative } = props;
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto">
      <Header title={t("canvas.tpl_ignorePreview")} />
      {!parentImageUrl ? (
        <div className="flex items-center gap-2 rounded-md border border-error-border bg-error-bg px-3 py-2.5 text-[12px] text-error">
          <TriangleAlert size={15} className="flex-shrink-0" />
          {t("canvas.tpl_captureFirst", { label: parentLabel })}
        </div>
      ) : (
        <>
          <div>
            <div className="mb-1 text-[11px] text-text-muted">{t("canvas.tpl_liveSelection")}</div>
            <CropPreview imageUrl={pageUrl} rect={working} height={90} />
          </div>
          <div className="flex flex-1 flex-col">
            <div className="mb-1 text-[11px] text-text-muted">
              {t("canvas.tpl_ignoredRed", { label: parentLabel })}
            </div>
            <ImageWithRedBox imageUrl={parentImageUrl} red={ignoreRelative} height={210} />
          </div>
        </>
      )}
    </div>
  );
}

function Header({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-1.5 w-1.5 rounded-full bg-orange" />
      <span className="text-[12px] font-semibold text-text-primary">{title}</span>
    </div>
  );
}

/** Draws an image fit-to-box with an optional red overlay rect (in image px). */
export function ImageWithRedBox({
  imageUrl,
  red,
  height,
}: {
  imageUrl: string;
  red: Rect | null;
  /** Fixed box height. Omit to fill the parent — e.g. inside a `ZoomPane`,
   * which supplies both the sizing and the surrounding chrome. */
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setImg(null);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = imageUrl;
  }, [imageUrl]);

  // Zooming resizes the canvas, which alone would leave the old drawing
  // stretched — remeasure so the redraw below reruns at the new size.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((p) => (p && p.w === r.width && p.h === r.height ? p : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!img) return;
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    // Magnifying: show the pixels as they are rather than smoothing the very
    // edges the variable area is being lined up against.
    ctx.imageSmoothingEnabled = scale <= 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
    if (red) {
      ctx.fillStyle = "rgba(226,75,74,0.20)";
      ctx.strokeStyle = "#E24B4A";
      ctx.lineWidth = 2;
      const rx = dx + red.x * scale;
      const ry = dy + red.y * scale;
      ctx.fillRect(rx, ry, red.w * scale, red.h * scale);
      ctx.strokeRect(rx, ry, red.w * scale, red.h * scale);
    }
  }, [img, red, box]);

  // `imageRendering: auto` opts out of a zoom pane's inherited `pixelated`:
  // the canvas already draws at the right scale, so the only thing left for the
  // browser to resample is the device-pixel-ratio step.
  const canvas = (
    <canvas ref={canvasRef} className="h-full w-full" style={{ imageRendering: "auto" }} />
  );
  if (height === undefined) return canvas;
  return (
    <div
      className="raqam-canvas-grid flex-1 overflow-hidden rounded-md border border-border"
      style={{ height }}
    >
      {canvas}
    </div>
  );
}

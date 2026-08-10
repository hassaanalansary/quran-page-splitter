import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Rect } from "@/lib/api/types";

type Props = {
  imageUrl: string;
  /** Region to preview, in natural image pixels. */
  rect: Rect | null;
  caption?: string;
  /** Preview box height in px. */
  height?: number;
  /**
   * Mirror the region horizontally across the page centerline before
   * magnifying — matches the alternate-margin engine crop. `rect` stays the
   * base (un-mirrored) selection.
   */
  mirrored?: boolean;
};

/**
 * Exact magnified preview of a crop region. Draws the region to a canvas with
 * `drawImage` (so it always matches the selection — no CSS/measurement drift)
 * and scales it to fit the box.
 */
export function CropPreview({ imageUrl, rect, caption, height = 220, mirrored = false }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    setImg(null);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = imageUrl;
  }, [imageUrl]);

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
    if (!img || !rect || rect.w < 1 || rect.h < 1) return;
    const scale = Math.min(w / rect.w, h / rect.h);
    const dw = rect.w * scale;
    const dh = rect.h * scale;
    const srcX = mirrored ? img.naturalWidth - (rect.x + rect.w) : rect.x;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, srcX, rect.y, rect.w, rect.h, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }, [img, rect, mirrored]);

  return (
    <div>
      <div
        className="raqam-canvas-grid overflow-hidden rounded-md border border-border"
        style={{ height }}
      >
        {rect ? (
          <canvas ref={canvasRef} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-text-muted">
            {t("canvas.cropPreviewEmpty")}
          </div>
        )}
      </div>
      {caption && <p className="mt-1 text-center text-[10.5px] text-text-muted">{caption}</p>}
    </div>
  );
}

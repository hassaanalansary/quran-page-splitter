import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Rect } from "@/lib/api/types";

type Props = {
  imageUrl: string;
  /** Region to preview, in natural image pixels. */
  rect: Rect | null;
  caption?: string;
  /** Preview box height in px. */
  height?: number;
};

/**
 * A magnified, fit-to-box preview of a rectangular region of a page image — so
 * the user can confirm a crop (bounds / template / ignore) without zooming the
 * main filmstrip. The page is rendered scaled and offset so the region is
 * centred and fills the box; overflow is clipped.
 */
export function CropPreview({ imageUrl, rect, caption, height = 160 }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: height });
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = boxRef.current;
      if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    setNat(null);
    const img = new Image();
    img.onload = () => setNat({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  const ready = rect !== null && nat !== null && box.w > 0;
  const scale = ready ? Math.min(box.w / rect.w, box.h / rect.h) : 1;
  const left = ready ? (box.w - rect.w * scale) / 2 - rect.x * scale : 0;
  const top = ready ? (box.h - rect.h * scale) / 2 - rect.y * scale : 0;

  return (
    <div>
      <div
        ref={boxRef}
        className="raqam-canvas-grid relative overflow-hidden rounded-md border border-border"
        style={{ height }}
      >
        {ready && nat ? (
          <img
            src={imageUrl}
            alt="Selection preview"
            draggable={false}
            style={{
              position: "absolute",
              width: nat.w * scale,
              height: nat.h * scale,
              left,
              top,
              maxWidth: "none",
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-text-muted">
            {rect ? "Loading…" : "Draw a region on the page to preview it here."}
          </div>
        )}
      </div>
      {caption && <p className="mt-1 text-center text-[10.5px] text-text-muted">{caption}</p>}
    </div>
  );
}

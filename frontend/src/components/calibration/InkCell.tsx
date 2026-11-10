import type { MouseEvent, ReactNode } from "react";

import { mediaUrl, type Rect } from "@/lib/api";

/** Image px shown around each blob, so a mark keeps a little of what it sits on. */
const PAD = 6;
/** Screen px a cell may take; a larger blob is cut to its middle, never shrunk. */
const MAX_W = 180;
const MAX_H = 120;
export const GALLERY_ZOOMS = [1.5, 2, 3] as const;

/**
 * One blob, cut from its line's image at one zoom and centred in its cell, its own box
 * outlined so a mark beside other ink is still the one meant. The Gallery's cells and
 * the Library's are the same: every crop at **one zoom**, so a madda stays wider than
 * a fatha and a dot smaller than a letter. `children` are badges laid over it.
 */
export function InkCell({
  imageUrl,
  imageSize,
  crop,
  zoom,
  settled = true,
  ring,
  title,
  data,
  onClick,
  onOpen,
  children,
}: {
  imageUrl: string | null;
  /** The image's own size. Lets it be loaded lazily: before it loads, an image of no
   * size, moved into place, sits outside the cell, and is never thought in view. */
  imageSize?: { w: number; h: number };
  /** The blob's box in its image's own pixels. */
  crop: Rect;
  zoom: number;
  /** A settled blob is drawn solid; a guess nobody accepted is dashed. */
  settled?: boolean;
  ring?: "chosen" | "doubt" | "gold" | null;
  title: string;
  /** What `data-gallery` holds, for the keys to find the cell by. */
  data?: string;
  onClick?: (event: MouseEvent) => void;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  const w = Math.min(MAX_W, (crop.w + 2 * PAD) * zoom);
  const h = Math.min(MAX_H, (crop.h + 2 * PAD) * zoom);
  // The blob's middle, in zoomed image px, lands in the cell's middle.
  const left = w / 2 - (crop.x + crop.w / 2) * zoom;
  const top = h / 2 - (crop.y + crop.h / 2) * zoom;
  return (
    <button
      type="button"
      data-gallery={data}
      title={title}
      aria-label={title}
      aria-pressed={ring === "chosen"}
      onClick={onClick}
      onDoubleClick={onOpen}
      className={`relative flex-none cursor-pointer overflow-hidden rounded-sm border bg-white ${
        settled ? "border-rule-2" : "border-dashed border-rule-2"
      } ${
        ring === "chosen"
          ? "ring-2 ring-lapis"
          : ring === "doubt"
            ? "ring-2 ring-warn"
            : ring === "gold"
              ? "ring-2 ring-gold"
              : ""
      }`}
      style={{
        width: w,
        height: h,
        contentVisibility: "auto",
        containIntrinsicSize: `${w}px ${h}px`,
      }}
    >
      {imageUrl && (
        <img
          src={mediaUrl(imageUrl)}
          alt=""
          draggable={false}
          loading={imageSize ? "lazy" : "eager"}
          className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
          style={{
            width: imageSize?.w,
            height: imageSize?.h,
            transform: `translate(${left}px, ${top}px) scale(${zoom})`,
            transformOrigin: "0 0",
            imageRendering: zoom > 1.6 ? "pixelated" : undefined,
          }}
        />
      )}
      <span
        className="pointer-events-none absolute rounded-[1px] border border-lapis/60"
        style={{
          left: w / 2 - (crop.w * zoom) / 2 - 1,
          top: h / 2 - (crop.h * zoom) / 2 - 1,
          width: crop.w * zoom + 2,
          height: crop.h * zoom + 2,
        }}
      />
      {children}
    </button>
  );
}

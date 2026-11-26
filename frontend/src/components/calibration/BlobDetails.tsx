import { mediaUrl } from "@/lib/api";
import type { KnifeVerdict } from "@/lib/calibration/blobCuts";

/** The knife on the one selected shared body, as the editor holds it. */
export type KnifeControls = {
  /** The knife is out on the selected blob: a drag on its line draws a cut. */
  active: boolean;
  /** What the last line drawn did, when it was dropped or another is needed. */
  note: KnifeVerdict | null;
  /** Take the knife out, or put it away without cutting. */
  onToggle: () => void;
  /** Give each piece the other word. */
  onSwap: () => void;
  /** Take the cut off: the words divide the blob at its middle again. */
  onClear: () => void;
};

/** One blob's own pixels, cut from its line's image at a readable size. */
export function BlobCrop({
  url,
  x,
  y,
  w,
  h,
  box = 72,
}: {
  url: string;
  /** The blob's box in the image's own pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  box?: number;
}) {
  const pad = 4;
  const cw = w + pad * 2;
  const ch = h + pad * 2;
  const k = Math.min(box / cw, box / ch, 4);
  return (
    <div
      className="relative flex-none overflow-hidden rounded-sm border border-rule bg-white"
      style={{ width: cw * k, height: ch * k }}
    >
      <img
        src={mediaUrl(url)}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
        style={{
          transform: `translate(${-(x - pad) * k}px, ${-(y - pad) * k}px) scale(${k})`,
          transformOrigin: "0 0",
          imageRendering: k > 1.6 ? "pixelated" : undefined,
        }}
      />
    </div>
  );
}

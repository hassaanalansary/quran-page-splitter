import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type Options = {
  /** The scrollable container that holds the (scaled) image. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The image element whose size is `natural × scale`. */
  imgRef: RefObject<HTMLElement | null>;
  /** The current effective scale — the value that changes on zoom. */
  scale: number;
  /** Skip anchoring (e.g. while in "fit" mode, which centres on its own). */
  enabled?: boolean;
};

/**
 * "Zoom to pointer": keeps the point under the cursor fixed whenever `scale`
 * changes, whatever triggered it (Ctrl+wheel, the zoom buttons, …).
 *
 * It records where the cursor sits on the image (as a fraction, which is
 * scale-independent) on every pointer move, then — in a `useLayoutEffect` that
 * runs after the resize commits but before paint — scrolls the container so that
 * same fraction is back under the pointer. Using a layout effect (not rAF) means
 * the new image size is always measured correctly, with no timing guesswork.
 */
export function useZoomToPointer({ scrollRef, imgRef, scale, enabled = true }: Options) {
  // Last cursor position: a fraction of the image + its client coords.
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const prevScale = useRef(scale);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      const img = imgRef.current;
      if (!img) return;
      const r = img.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      anchor.current = {
        fx: (e.clientX - r.left) / r.width,
        fy: (e.clientY - r.top) / r.height,
        cx: e.clientX,
        cy: e.clientY,
      };
    };
    el.addEventListener("pointermove", onMove);
    return () => el.removeEventListener("pointermove", onMove);
  }, [scrollRef, imgRef]);

  useLayoutEffect(() => {
    const prev = prevScale.current;
    prevScale.current = scale;
    if (!enabled || prev === scale) return;
    const el = scrollRef.current;
    const img = imgRef.current;
    const a = anchor.current;
    if (!el || !img || !a) return;
    const r = img.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    // The anchored fraction now sits at (r.left + fx·w, …); scroll it back to the
    // pointer. Increasing scrollLeft moves the content left, toward the cursor.
    el.scrollLeft += r.left + a.fx * r.width - a.cx;
    el.scrollTop += r.top + a.fy * r.height - a.cy;
  }, [scale, enabled, scrollRef, imgRef]);
}

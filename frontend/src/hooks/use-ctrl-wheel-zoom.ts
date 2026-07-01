import { useEffect, type RefObject } from "react";

type UseCtrlWheelZoomOptions = {
  /** Ref to the scrollable/zoomable container element. */
  ref: RefObject<HTMLElement | null>;
  /** Current zoom level (used as the base for the exponential factor). */
  zoom: number;
  /** Called with the new zoom value. */
  onZoomChange?: (z: number) => void;
  /** Minimum zoom. @default 0.1 */
  min?: number;
  /** Maximum zoom. @default 8 */
  max?: number;
};

/**
 * Ctrl + mouse-wheel zoom.
 *
 * Attaches a **non-passive** `wheel` listener on the given element so
 * `preventDefault()` can suppress the browser's native pinch-zoom /
 * scroll behaviour.
 */
export function useCtrlWheelZoom({
  ref,
  zoom,
  onZoomChange,
  min = 0.1,
  max = 8,
}: UseCtrlWheelZoomOptions) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !onZoomChange) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.max(min, Math.min(max, zoom * factor));
      onZoomChange!(Number(next.toFixed(3)));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, zoom, onZoomChange, min, max]);
}

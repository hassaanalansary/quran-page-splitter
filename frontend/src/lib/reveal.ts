/** Scroll a container just enough to bring one of its children into view.
 *
 * `Element.scrollIntoView` was the other option and is the wrong tool twice over:
 * it scrolls **every** scrollable ancestor, so revealing a word inside the canvas
 * can move the panel or the page with it; and even `block: "nearest"` re-centres
 * more eagerly than a reviewer wants while they are working down a line.
 *
 * This moves one named scroller, by the smallest amount that works, and does
 * nothing at all when the target is already comfortably inside the viewport — which
 * is what makes it safe to run on *every* selection change from either direction.
 * A click in the canvas scrolls the list and leaves the canvas alone; a click in the
 * list does the reverse; neither needs to know which one the user touched.
 */

type RevealOptions = {
  /** Clear space to keep between the target and the scroller's edge. */
  margin?: number;
  /** Which axes may move.
   *
   * `"vertical"` is for a target as wide as the scroller or wider — a whole line
   * strip. Both its edges are then outside the view, so a horizontal reveal has to
   * pick one, and either choice is wrong: pulling in the left edge parks the reader
   * at the *end* of a line that reads right to left, and pulling in the right edge
   * moves them sideways when all they did was step down a line. Leaving the
   * horizontal scroll where the reader put it is the only answer that is never
   * surprising. */
  axis?: "both" | "vertical";
};

export function revealInScroller(
  scroller: HTMLElement | null | undefined,
  target: HTMLElement | null | undefined,
  { margin = 12, axis: which = "both" }: RevealOptions = {},
): void {
  if (!scroller || !target) return;
  const view = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  if (view.width <= 0 || view.height <= 0) return;

  const left = which === "both" ? axis(box.left, box.right, view.left, view.right, margin) : 0;
  const top = axis(box.top, box.bottom, view.top, view.bottom, margin);
  if (!left && !top) return;

  scroller.scrollBy({
    left,
    top,
    behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

/** How far to scroll one axis: negative toward the start, 0 when already in view.
 *
 * The `Math.min` on the far-edge branch is for a target **larger** than the
 * viewport — a very wide word at high zoom. Without it, pulling its far edge into
 * view would push its near edge out, and the reviewer would be looking at the end
 * of a word whose beginning they wanted.
 */
function axis(start: number, end: number, low: number, high: number, margin: number): number {
  const near = start - (low + margin);
  const far = end - (high - margin);
  if (near < 0) return near;
  if (far > 0) return Math.min(far, near);
  return 0;
}

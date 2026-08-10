/** Tiny, SSR-safe localStorage flag helpers for one-off UI preferences
 * (guide collapse, canvas-coach dismissal, tour "seen" state). */

export function readFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* ignore quota / disabled storage */
  }
}

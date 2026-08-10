import { useCallback, useEffect, useState } from "react";

import { readFlag, writeFlag } from "@/lib/prefs";

export type TourStep = {
  /** Value of the `data-tour` attribute on the element to spotlight. */
  target: string;
  title: string;
  body: string;
};

export type TourController = {
  steps: TourStep[];
  index: number;
  active: boolean;
  start: () => void;
  stop: () => void;
  next: () => void;
  back: () => void;
};

/** Drives a first-run coach-mark tour for one step. Auto-starts once per
 * `storageKey` (remembered in localStorage); `start()` replays it on demand. */
export function useStepTour(
  storageKey: string,
  steps: TourStep[],
  autoStart = true,
): TourController {
  const key = `tour:${storageKey}:done`;
  const [index, setIndex] = useState(-1);

  // First visit only, and only when the step is genuinely fresh (autoStart) —
  // so opening an already-handled mushaf never triggers the tour. `start()`
  // still replays it on demand regardless.
  useEffect(() => {
    if (!autoStart || readFlag(key) || steps.length === 0) return;
    const id = window.setTimeout(() => setIndex(0), 500);
    return () => window.clearTimeout(id);
  }, [key, steps.length, autoStart]);

  const stop = useCallback(() => {
    writeFlag(key, true);
    setIndex(-1);
  }, [key]);
  const start = useCallback(() => setIndex(0), []);
  const next = useCallback(
    () => setIndex((i) => Math.min(steps.length - 1, i + 1)),
    [steps.length],
  );
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  return { steps, index, active: index >= 0 && index < steps.length, start, stop, next, back };
}

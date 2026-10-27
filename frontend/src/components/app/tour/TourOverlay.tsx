import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { TourController } from "./useStepTour";

type Box = { top: number; left: number; width: number; height: number };

const CARD_W = 300;
const CARD_H = 176; // estimate used only for above/below placement
const GAP = 12;
const PAD = 6;

/** Renders the active step of a {@link TourController}: a spotlight cut-out
 * around the target `data-tour` element plus an anchored info card. */
export function TourOverlay({ tour }: { tour: TourController }) {
  const { t } = useTranslation();
  const { steps, index, active, next, back, stop } = tour;
  const step = active ? steps[index] : null;
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    if (!step) {
      setBox(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el instanceof HTMLElement) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) {
          setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
          return;
        }
      }
      setBox(null); // target absent → centered card, full dim
    };
    measure();
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
      cancelAnimationFrame(raf);
    };
  }, [step]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, stop]);

  if (!step) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

  const spot = box
    ? {
        top: box.top - PAD,
        left: box.left - PAD,
        width: box.width + PAD * 2,
        height: box.height + PAD * 2,
      }
    : null;

  let cardTop: number;
  let cardLeft: number;
  if (spot) {
    const below = spot.top + spot.height + GAP;
    const above = spot.top - CARD_H - GAP;
    cardTop =
      below + CARD_H <= vh - GAP
        ? below
        : above >= GAP
          ? above
          : clamp((vh - CARD_H) / 2, GAP, vh - CARD_H - GAP);
    cardLeft = clamp(spot.left, GAP, vw - CARD_W - GAP);
  } else {
    cardTop = (vh - CARD_H) / 2;
    cardLeft = (vw - CARD_W) / 2;
  }

  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* Click-catcher: full dim when there's no target, else transparent (the
          spotlight box-shadow supplies the dim). Clicking outside skips. */}
      <button
        type="button"
        aria-label={t("tour.skip")}
        onClick={stop}
        className={`absolute inset-0 h-full w-full cursor-default ${spot ? "" : "bg-scrim"}`}
      />

      {spot && (
        <div
          className="pointer-events-none absolute rounded-lg"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: "0 0 0 4px var(--gold), 0 0 0 9999px var(--scrim)",
          }}
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-label={step.title}
        className="absolute flex flex-col gap-2 rounded-card bg-card p-3.5 text-ink shadow-[0_10px_30px_rgba(0,0,0,0.3)]"
        style={{ top: cardTop, left: cardLeft, width: CARD_W }}
      >
        <span className="font-mono text-[11.5px] font-semibold text-ink-3">
          {t("tour.stepCount", { current: index + 1, total: steps.length })}
        </span>
        <strong className="text-[15px] leading-snug">{step.title}</strong>
        <p className="m-0 text-[12.5px] leading-normal text-ink-2">{step.body}</p>
        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            onClick={stop}
            className="h-8 cursor-pointer px-2 text-[12.5px] font-semibold text-ink-3 hover:text-ink"
          >
            {t("tour.skip")}
          </button>
          <div className="flex gap-1.5">
            {!isFirst && (
              <button
                type="button"
                onClick={back}
                className="h-8 cursor-pointer rounded-control border border-rule-2 bg-card px-2.5 text-[12.5px] font-semibold text-ink hover:bg-sheet"
              >
                {t("tour.back")}
              </button>
            )}
            <button
              type="button"
              onClick={isLast ? stop : next}
              className="h-8 cursor-pointer rounded-control bg-lapis px-3 text-[12.5px] font-semibold text-on-lapis hover:bg-lapis/90"
            >
              {isLast ? t("tour.done") : t("tour.next")}
            </button>
          </div>
        </div>
      </div>

      {/* Where the tour is: the current step a long gold bar. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center gap-1.5"
      >
        {steps.map((_, i) => (
          <span
            key={i}
            className={`h-[5px] rounded-[3px] ${i === index ? "w-[22px] bg-gold" : "w-2 bg-white/40"}`}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

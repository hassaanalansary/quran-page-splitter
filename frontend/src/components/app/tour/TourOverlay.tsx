import { X } from "lucide-react";
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
        className={`absolute inset-0 h-full w-full cursor-default ${spot ? "" : "bg-black/55"}`}
      />

      {spot && (
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-orange/70"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        className="absolute flex flex-col gap-2 rounded-xl border border-border bg-white p-4 shadow-xl"
        style={{ top: cardTop, left: cardLeft, width: CARD_W }}
      >
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-[13.5px] font-semibold text-text-primary">{step.title}</h3>
          <button
            type="button"
            aria-label={t("tour.skip")}
            onClick={stop}
            className="-me-1 -mt-1 flex-none rounded p-1 text-text-muted hover:bg-bg-surface hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-[12px] leading-[1.5] text-text-secondary">{step.body}</p>
        <div className="mt-1 flex items-center justify-between">
          <span className="font-mono text-[10.5px] text-text-muted">
            {t("tour.stepCount", { current: index + 1, total: steps.length })}
          </span>
          <div className="flex gap-1.5">
            {!isFirst && (
              <button
                type="button"
                onClick={back}
                className="rounded-md border-[1.5px] border-border-strong bg-white px-2.5 py-1 text-[11.5px] font-medium text-text-secondary hover:bg-bg-surface"
              >
                {t("tour.back")}
              </button>
            )}
            <button
              type="button"
              onClick={isLast ? stop : next}
              className="rounded-md bg-orange px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-orange-hover"
            >
              {isLast ? t("tour.done") : t("tour.next")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

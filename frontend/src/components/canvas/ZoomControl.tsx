import { Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Zoom multiplier; -1 = "fit to canvas". */
export type Zoom = number;

type Props = {
  value: Zoom;
  onChange: (z: Zoom) => void;
  /** Buttons that share the pill, before or after the zoom, each behind a rule
   * (undo and redo). */
  before?: ReactNode;
  after?: ReactNode;
};

/** The scales − and + step through (natural-pixel multipliers). */
const STEPS: Zoom[] = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Zoom stepper in a canvas toolbar: −, the current scale, +, and Fit. From Fit,
 * − goes to half size and + to actual size; otherwise each steps one notch. A
 * scale set by the wheel steps from wherever it is. */
export function ZoomControl({ value, onChange, before, after }: Props) {
  const { t } = useTranslation();
  const fit = value === -1;
  const lower = fit ? 0.5 : [...STEPS].reverse().find((s) => s < value - 1e-6);
  const higher = fit ? 1 : STEPS.find((s) => s > value + 1e-6);
  const button =
    "flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[6px] text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:opacity-30";

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-rule bg-sheet p-[3px]">
      {before && (
        <>
          {before}
          <span className="h-[18px] w-px bg-rule" aria-hidden="true" />
        </>
      )}
      <button
        type="button"
        onClick={() => lower !== undefined && onChange(lower)}
        disabled={lower === undefined}
        aria-label={t("canvas.zoomOut")}
        title={t("canvas.zoomOut")}
        className={button}
      >
        <Minus size={15} aria-hidden="true" />
      </button>
      <span className="min-w-[46px] text-center font-mono text-[13px] text-ink-2">
        {fit ? t("canvas.fit") : `${Math.round(value * 100)}%`}
      </span>
      <button
        type="button"
        onClick={() => higher !== undefined && onChange(higher)}
        disabled={higher === undefined}
        aria-label={t("canvas.zoomIn")}
        title={t("canvas.zoomIn")}
        className={button}
      >
        <Plus size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onChange(-1)}
        aria-pressed={fit}
        className={`h-[30px] cursor-pointer rounded-[6px] px-2.5 text-[13px] font-semibold transition-colors ${
          fit ? "bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-2 hover:bg-sunk"
        }`}
      >
        {t("canvas.fit")}
      </button>
      {after && (
        <>
          <span className="h-[18px] w-px bg-rule" aria-hidden="true" />
          {after}
        </>
      )}
    </div>
  );
}

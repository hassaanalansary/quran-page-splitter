import { useTranslation } from "react-i18next";

/** Zoom multiplier; -1 = "fit to canvas". */
export type Zoom = number;

type Props = {
  value: Zoom;
  onChange: (z: Zoom) => void;
};

const OPTIONS: { v: Zoom; label: string | null }[] = [
  { v: 0.5, label: "50%" },
  { v: 1, label: "100%" },
  { v: 2, label: "200%" },
  { v: -1, label: null },
];

/** Zoom preset segmented control (50% / 100% / 200% / Fit). */
export function ZoomControl({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex h-[30px] overflow-hidden rounded-sm border-[1.5px] border-rule-2">
      {OPTIONS.map((o, i) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "px-[9px] text-[11.5px] font-medium transition-colors cursor-pointer",
            i < OPTIONS.length - 1 ? "border-e border-rule" : "",
            value === o.v ? "bg-sunk text-ink" : "bg-card text-ink-2 hover:bg-sheet",
          ].join(" ")}
        >
          {o.label ?? t("canvas.fit")}
        </button>
      ))}
    </div>
  );
}

/** Zoom multiplier; -1 = "fit to canvas". */
export type Zoom = number;

type Props = {
  value: Zoom;
  onChange: (z: Zoom) => void;
};

const OPTIONS: { v: Zoom; label: string }[] = [
  { v: 0.5, label: "50%" },
  { v: 1, label: "100%" },
  { v: 2, label: "200%" },
  { v: -1, label: "Fit" },
];

/** Zoom preset segmented control (50% / 100% / 200% / Fit). */
export function ZoomControl({ value, onChange }: Props) {
  return (
    <div className="flex h-[30px] overflow-hidden rounded-sm border-[1.5px] border-border-strong">
      {OPTIONS.map((o, i) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "px-[9px] text-[11.5px] font-medium transition-colors",
            i < OPTIONS.length - 1 ? "border-r border-border" : "",
            value === o.v
              ? "bg-bg-muted text-text-primary"
              : "bg-white text-text-secondary hover:bg-bg-surface",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

import { useTranslation } from "react-i18next";

import type { Rect } from "@/lib/api/types";

type Props = {
  rect: Rect | null;
  onChange: (r: Rect) => void;
  /** Natural image size, used to clamp values to the page. */
  max?: { w: number; h: number } | null;
  /** Read-only display, e.g. while the rect is locked. */
  disabled?: boolean;
};

/** Pixel-precise x/y/w/h editing of a crop rectangle. */
export function RectInputs({ rect, onChange, max, disabled }: Props) {
  const { t } = useTranslation();
  if (!rect) {
    return <p className="text-[11px] text-text-muted">{t("canvas.rectHint")}</p>;
  }

  const apply = (patch: Partial<Rect>) => {
    const next = { ...rect, ...patch };
    next.x = Math.max(0, max ? Math.min(max.w - 1, next.x) : next.x);
    next.y = Math.max(0, max ? Math.min(max.h - 1, next.y) : next.y);
    next.w = Math.max(1, max ? Math.min(max.w - next.x, next.w) : next.w);
    next.h = Math.max(1, max ? Math.min(max.h - next.y, next.h) : next.h);
    onChange({
      x: Math.round(next.x),
      y: Math.round(next.y),
      w: Math.round(next.w),
      h: Math.round(next.h),
    });
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      <Num label="X" value={rect.x} onChange={(v) => apply({ x: v })} disabled={disabled} />
      <Num label="Y" value={rect.y} onChange={(v) => apply({ y: v })} disabled={disabled} />
      <Num label="W" value={rect.w} onChange={(v) => apply({ w: v })} disabled={disabled} />
      <Num label="H" value={rect.h} onChange={(v) => apply({ h: v })} disabled={disabled} />
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-3 text-[11px] font-semibold text-text-muted">{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        disabled={disabled}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        className="h-8 w-full rounded border-[1.5px] border-border-strong px-2 text-right text-[12px] tabular-nums outline-none focus:border-orange disabled:cursor-not-allowed disabled:bg-bg-surface disabled:text-text-muted"
      />
    </label>
  );
}

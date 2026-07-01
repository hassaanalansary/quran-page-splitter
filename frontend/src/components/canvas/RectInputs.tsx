import type { Rect } from "@/lib/api/types";

type Props = {
  rect: Rect | null;
  onChange: (r: Rect) => void;
  /** Natural image size, used to clamp values to the page. */
  max?: { w: number; h: number } | null;
};

/** Pixel-precise x/y/w/h editing of a crop rectangle. */
export function RectInputs({ rect, onChange, max }: Props) {
  if (!rect) {
    return <p className="text-[11px] text-text-muted">Draw a region to fine-tune it by pixel.</p>;
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
      <Num label="X" value={rect.x} onChange={(v) => apply({ x: v })} />
      <Num label="Y" value={rect.y} onChange={(v) => apply({ y: v })} />
      <Num label="W" value={rect.w} onChange={(v) => apply({ w: v })} />
      <Num label="H" value={rect.h} onChange={(v) => apply({ h: v })} />
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-3 text-[11px] font-semibold text-text-muted">{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        className="h-8 w-full rounded border-[1.5px] border-border-strong px-2 text-right text-[12px] tabular-nums outline-none focus:border-orange"
      />
    </label>
  );
}

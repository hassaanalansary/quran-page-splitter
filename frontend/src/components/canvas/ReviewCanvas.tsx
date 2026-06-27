import { useEffect, useRef, useState } from "react";

import type { Line, LineType, Rect } from "@/lib/api/types";

type Props = {
  imageUrl: string | null;
  lines: Line[];
  bbox: Rect | null;
  selected: number | null;
  onSelect: (lineNumber: number | null) => void;
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
};

const TYPE_COLOR: Record<LineType, string> = {
  text: "var(--orange)",
  sura_header: "var(--navy)",
  besmella: "var(--success)",
};

/** Read-only page viewer with selectable line/segment overlays and aya labels. */
export function ReviewCanvas({
  imageUrl,
  lines,
  bbox,
  selected,
  onSelect,
  page,
  pageCount,
  onPageChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => setNatural(null), [imageUrl]);

  useEffect(() => {
    if (!natural || !scrollRef.current) return;
    const el = scrollRef.current;
    const compute = () => setScale(Math.min((el.clientWidth - 48) / natural.w, 1.5));
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural]);

  const displayW = natural ? natural.w * scale : 0;
  const displayH = natural ? natural.h * scale : 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3">
        <NavButton label="Prev" disabled={page <= 1} onClick={() => onPageChange(page - 1)} />
        <span className="text-[12.5px] font-medium text-text-secondary">
          Page {page} / {pageCount}
        </span>
        <NavButton
          label="Next"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        />
      </div>

      <div
        ref={scrollRef}
        className="raqam-canvas-grid relative flex-1 overflow-auto"
        onClick={() => onSelect(null)}
      >
        {imageUrl ? (
          <div className="relative mx-auto my-8" style={{ width: displayW || "auto" }}>
            <div
              className="relative rounded-[4px] border border-border bg-white"
              style={{ boxShadow: "var(--shadow-page)", width: displayW || "auto", height: displayH || "auto" }}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt={`Page ${page}`}
                draggable={false}
                onLoad={(e) =>
                  setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                }
                style={{ width: displayW || "auto", height: displayH || "auto", display: "block" }}
              />
              {natural &&
                lines.map((line) => (
                  <LineBox
                    key={line.line_number}
                    line={line}
                    natural={natural}
                    selected={selected === line.line_number}
                    onSelect={onSelect}
                  />
                ))}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-text-secondary">
            No page image.
          </div>
        )}
      </div>
    </div>
  );
}

function LineBox({
  line,
  natural,
  selected,
  onSelect,
}: {
  line: Line;
  natural: { w: number; h: number };
  selected: boolean;
  onSelect: (n: number | null) => void;
}) {
  const color = TYPE_COLOR[line.type];
  const pct = (v: number, dim: "w" | "h") => (v / (dim === "w" ? natural.w : natural.h)) * 100;

  return (
    <>
      <div
        onClick={(e) => {
          e.stopPropagation();
          onSelect(line.line_number);
        }}
        className="absolute cursor-pointer rounded-[2px] transition-colors"
        style={{
          left: `${pct(line.bbox_x, "w")}%`,
          top: `${pct(line.bbox_y, "h")}%`,
          width: `${pct(line.bbox_w, "w")}%`,
          height: `${pct(line.bbox_h, "h")}%`,
          border: `${selected ? 2 : 1.5}px solid ${color}`,
          backgroundColor: selected
            ? "color-mix(in oklab, var(--orange) 10%, transparent)"
            : "transparent",
        }}
      >
        <span
          className="absolute -top-[7px] left-0 rounded-pill px-1 text-[8px] font-semibold leading-[1.4] text-white"
          style={{ background: color }}
        >
          {line.line_number}
        </span>
      </div>

      {line.type === "text" &&
        line.segments.map((seg) => {
          const left = pct(seg.bbox_x, "w");
          const top = pct(line.bbox_y, "h");
          const width = pct(seg.bbox_w, "w");
          const height = pct(line.bbox_h, "h");
          return (
            <div
              key={seg.segment_order}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(line.line_number);
              }}
              className="pointer-events-auto absolute flex cursor-pointer items-end justify-center"
              style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
            >
              {seg.has_separator && (
                <span
                  className="absolute bottom-0 left-0 top-0 w-[2px]"
                  style={{ background: "var(--orange)" }}
                />
              )}
              <span
                className="mb-[1px] rounded-[2px] bg-white/85 px-[3px] text-[8px] font-bold leading-none text-orange"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {seg.aya_number ?? "?"}
              </span>
            </div>
          );
        })}
    </>
  );
}

function NavButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-8 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-3 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}

import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import type { LineType } from "@/lib/api";

/** Per-type accent, matching the line-box colours on the canvas so the panel
 * reads as the same object (orange = text, navy = sura header, green = besmella). */
const LINE_TYPE_COLOR: Record<LineType, string> = {
  text: "var(--orange)",
  sura_header: "var(--navy)",
  besmella: "var(--success)",
};

/** One line as the navigator shows it. `key` is whatever the page uses for
 * identity — a uid in Review, the line number in Finalize. */
export type NavigatorLine = {
  key: string;
  line_number: number;
  type: LineType;
  /** Short summary under the position (ayat covered, strokes, …). */
  summary?: ReactNode;
  /** Extra chips beside the type chip (edited / png …). */
  badges?: ReactNode;
};

/** Compact line stepper: prev/next through the page's lines with the current
 * one summarised. Replaces a scrolling list — on a page of 15 near-identical
 * lines, stepping is how you actually move; the canvas is the real index. */
export function LineNavigator({
  title,
  lines,
  selectedKey,
  onSelect,
  onAdd,
  addLabel,
  emptyText,
}: {
  title: string;
  lines: NavigatorLine[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Omit to hide the add button (Finalize can't add lines). */
  onAdd?: () => void;
  addLabel?: string;
  emptyText: string;
}) {
  const { t } = useTranslation();
  const total = lines.length;
  const idx = lines.findIndex((l) => l.key === selectedKey);
  // Before the auto-select effect runs, fall back to the first line for display.
  const safeIdx = idx >= 0 ? idx : 0;
  const current: NavigatorLine | undefined = lines[safeIdx];
  const color = current ? LINE_TYPE_COLOR[current.type] : "var(--orange)";

  return (
    <div className="rounded-md border border-border bg-white">
      <div className="flex items-center justify-between border-b border-border bg-orange-tint px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-orange">
          {title}
        </span>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="flex cursor-pointer items-center gap-1 rounded-sm border-[1.5px] border-orange bg-white px-2 py-[3px] text-[11px] font-semibold text-orange hover:bg-orange hover:text-white"
          >
            <Plus size={12} /> {addLabel}
          </button>
        )}
      </div>

      {total === 0 || !current ? (
        <p className="px-3 py-3 text-[12px] text-text-muted">{emptyText}</p>
      ) : (
        <div className="flex items-stretch">
          <NavArrow
            dir="up"
            title={t("review.prevLine")}
            disabled={safeIdx <= 0}
            onClick={() => onSelect(lines[safeIdx - 1].key)}
          />
          <button
            type="button"
            onClick={() => onSelect(current.key)}
            className="flex flex-1 cursor-pointer flex-col gap-1 border-x border-border px-3 py-2 text-start transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = `color-mix(in oklab, ${color} 8%, transparent)`)
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = "")}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="font-mono text-[12px] font-semibold" style={{ color }}>
                {t("review.linePosition", { n: current.line_number, total })}
              </span>
              <span className="flex items-center gap-1">
                {current.badges}
                <TypeChip type={current.type} />
              </span>
            </span>
            {current.summary && (
              <span className="truncate text-[11.5px] text-text-secondary">{current.summary}</span>
            )}
          </button>
          <NavArrow
            dir="down"
            title={t("review.nextLine")}
            disabled={safeIdx >= total - 1}
            onClick={() => onSelect(lines[safeIdx + 1].key)}
          />
        </div>
      )}
    </div>
  );
}

function NavArrow({
  dir,
  title,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex w-10 flex-none cursor-pointer items-center justify-center transition-colors bg-bg-surface text-navy hover:bg-transparent disabled:cursor-not-allowed disabled:text-text-muted disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {dir === "up" ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
    </button>
  );
}

export function TypeChip({ type }: { type: LineType }) {
  const { t } = useTranslation();
  return (
    <span
      className="rounded-pill px-[6px] py-[1px] text-[9.5px] font-semibold uppercase tracking-wider text-white"
      style={{ background: LINE_TYPE_COLOR[type] }}
    >
      {t(`review.chip_${type}`)}
    </span>
  );
}

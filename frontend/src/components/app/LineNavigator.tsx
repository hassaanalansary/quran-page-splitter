import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import type { LineType } from "@/lib/api";

/** One line as the navigator shows it. `key` is whatever the page uses for
 * identity — a uid in Review, the line number in Lines. */
export type NavigatorLine = {
  key: string;
  line_number: number;
  type: LineType;
  /** Short summary under the position (ayat covered, height and strokes, …). */
  summary?: ReactNode;
  /** Extra chips beside the position (edited / png …). */
  badges?: ReactNode;
};

/** Compact line stepper: ↑ ↓ through the page's lines with the current one
 * summarised, and the step's line actions at the end. Replaces a scrolling list —
 * on a page of 15 near-identical lines, stepping is how you actually move; the
 * canvas is the real index. */
export function LineNavigator({
  lines,
  selectedKey,
  onSelect,
  actions,
  emptyText,
}: {
  lines: NavigatorLine[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Buttons at the end of the card (Review's add and delete). */
  actions?: ReactNode;
  emptyText: string;
}) {
  const { t } = useTranslation();
  const total = lines.length;
  const idx = lines.findIndex((l) => l.key === selectedKey);
  // Before the auto-select effect runs, fall back to the first line for display.
  const safeIdx = idx >= 0 ? idx : 0;
  const current: NavigatorLine | undefined = lines[safeIdx];

  return (
    <div className="flex items-center gap-2.5 rounded-card border border-rule bg-card p-2.5">
      <div className="flex flex-none flex-col gap-0.5">
        <NavArrow
          dir="up"
          title={t("review.prevLine")}
          disabled={!current || safeIdx <= 0}
          onClick={() => onSelect(lines[safeIdx - 1].key)}
        />
        <NavArrow
          dir="down"
          title={t("review.nextLine")}
          disabled={!current || safeIdx >= total - 1}
          onClick={() => onSelect(lines[safeIdx + 1].key)}
        />
      </div>

      {total === 0 || !current ? (
        <p className="m-0 min-w-0 flex-1 text-[12.5px] leading-snug text-ink-3">{emptyText}</p>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="text-[15px] font-semibold">
              {t("review.lineN", { n: current.line_number })}{" "}
              <span className="font-normal text-ink-3">/ {total}</span>
            </span>
            {current.type !== "text" && <TypeChip type={current.type} />}
            {current.badges}
          </span>
          {current.summary && (
            <span className="truncate text-[12.5px] text-ink-2">{current.summary}</span>
          )}
        </div>
      )}

      {actions && <div className="flex flex-none items-center gap-1.5">{actions}</div>}
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
      className="flex h-[22px] w-[30px] cursor-pointer items-center justify-center rounded-[5px] border border-rule bg-sheet text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:opacity-40 disabled:hover:bg-sheet"
    >
      {dir === "up" ? (
        <ChevronUp size={14} aria-hidden="true" />
      ) : (
        <ChevronDown size={14} aria-hidden="true" />
      )}
    </button>
  );
}

/** A line that isn't text, named in its canvas tag's colour: a sura header is an
 * ornament. */
export function TypeChip({ type }: { type: LineType }) {
  const { t } = useTranslation();
  const background =
    type === "sura_header"
      ? "var(--ov-ornament)"
      : type === "besmella"
        ? "var(--ov-besmella)"
        : "var(--ov-line-selected)";
  return (
    <span
      className="rounded-[3px] px-[5px] py-px text-[10.5px] font-semibold text-white"
      style={{ background }}
    >
      {t(`review.chip_${type}`)}
    </span>
  );
}

import { useTranslation } from "react-i18next";

import { mushafStatus, type MushafStatus, type PageCounts } from "@/lib/api";

const STATUS_STYLE: Record<MushafStatus, { dot: string; text: string; bg: string }> = {
  empty: { dot: "var(--ink-4)", text: "text-ink-3", bg: "bg-sunk" },
  partial: { dot: "var(--warn)", text: "text-warn-text", bg: "bg-warn-wash" },
  processed: { dot: "var(--lapis)", text: "text-lapis-text", bg: "bg-lapis-wash" },
  completed: { dot: "var(--done)", text: "text-done-text", bg: "bg-done-wash" },
};

/** How far through the pipeline a mushaf is, as a coloured pill.
 *
 * Shared by the owner's shelf, the gallery cards and the read-only detail page
 * so that "completed" looks the same wherever it is read.
 */
export function MushafStatusBadge({
  mushaf,
  size = "sm",
  className = "",
}: {
  mushaf: PageCounts;
  size?: "sm" | "md";
  className?: string;
}) {
  const { t } = useTranslation();
  const key = mushafStatus(mushaf);
  const style = STATUS_STYLE[key];
  const scale = size === "md" ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill font-semibold ${scale} ${style.bg} ${style.text} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.dot }} />
      {t(`status.${key}`)}
    </span>
  );
}

import { useTranslation } from "react-i18next";

import { mushafStatus, type MushafStatus, type PageCounts } from "@/lib/api";

const STATUS_STYLE: Record<MushafStatus, { dot: string; text: string; bg: string }> = {
  empty: { dot: "var(--text-muted)", text: "text-text-muted", bg: "bg-bg-muted" },
  partial: { dot: "var(--warning)", text: "text-[#92400E]", bg: "bg-warning-bg" },
  processed: { dot: "var(--navy-light)", text: "text-navy", bg: "bg-bg-muted" },
  completed: { dot: "var(--success)", text: "text-success", bg: "bg-success-bg" },
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

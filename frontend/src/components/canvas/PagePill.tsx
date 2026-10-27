import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageJump } from "@/components/canvas/PageJump";

/**
 * The page control in a canvas toolbar: next, the page (click it to type one), and
 * previous. Mushaf order in every language: the left arrow turns to the next page,
 * as in an Arabic book, and the right one goes back.
 */
export function PagePill({
  page,
  pageCount,
  onPageChange,
  label,
}: {
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  /** Secondary label, e.g. the physical PDF page. */
  label?: string;
}) {
  const { t, i18n } = useTranslation();
  const arrow =
    "flex h-[30px] w-[34px] cursor-pointer items-center justify-center rounded-[6px] text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:opacity-30";
  return (
    // Laid out left to right whatever the UI's direction: the arrows are physical.
    <div
      dir="ltr"
      className="inline-flex items-center gap-1 rounded-lg border border-rule bg-sheet p-[3px]"
    >
      <button
        type="button"
        onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        disabled={page >= pageCount}
        aria-label={t("canvas.nextPage")}
        title={t("canvas.nextPage")}
        className={arrow}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <span className="px-1.5" dir={i18n.dir()}>
        <PageJump page={page} pageCount={pageCount} onPageChange={onPageChange} label={label} />
      </span>
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        aria-label={t("canvas.prevPage")}
        title={t("canvas.prevPage")}
        className={arrow}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

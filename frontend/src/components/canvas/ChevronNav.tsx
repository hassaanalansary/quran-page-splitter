import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

type Props = {
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
};

/** Floating prev/next chevrons, positioned over a page canvas. */
export function ChevronNav({ page, pageCount, onPageChange }: Props) {
  return (
    <>
      <Chevron side="left" disabled={page <= 1} onClick={() => onPageChange(page - 1)} />
      <Chevron side="right" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)} />
    </>
  );
}

function Chevron({
  side,
  onClick,
  disabled,
}: {
  side: "left" | "right";
  onClick: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? t("canvas.prevPage") : t("canvas.nextPage")}
      className={[
        "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center cursor-pointer rounded-full border border-border bg-white/90 text-text-secondary shadow-[var(--shadow-md)] backdrop-blur transition hover:text-orange disabled:cursor-not-allowed disabled:opacity-30",
        side === "left" ? "left-3" : "right-3",
      ].join(" ")}
    >
      {side === "left" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  /** Optional secondary label, e.g. the physical PDF page. */
  label?: string;
};

/** "Page N / total" indicator; click the number to type a page to jump to. */
export function PageJump({ page, pageCount, onPageChange, label }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  function commit() {
    const n = Math.max(1, Math.min(pageCount, Math.round(Number(value) || page)));
    onPageChange(n);
    setEditing(false);
    setValue("");
  }

  return (
    <div className="flex items-center gap-2 text-[12px]">
      {editing ? (
        <input
          autoFocus
          type="number"
          min={1}
          max={pageCount}
          value={value}
          placeholder={String(page)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setEditing(false);
              setValue("");
            }
          }}
          onBlur={commit}
          className="h-6 w-14 rounded border border-border-strong px-1.5 text-center tabular-nums outline-none focus:border-orange"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setValue("");
            setEditing(true);
          }}
          className="font-semibold tabular-nums text-text-primary hover:text-orange"
          title={t("canvas.jumpTitle")}
        >
          {t("canvas.pageJump", { page })}
        </button>
      )}
      <span className="text-text-muted">/ {pageCount}</span>
      {label && <span className="border-s border-border ps-2 text-text-secondary">{label}</span>}
    </div>
  );
}

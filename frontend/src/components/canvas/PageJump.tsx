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
          className="h-6 w-14 rounded border border-rule-2 px-1.5 text-center tabular-nums outline-none focus:border-lapis"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setValue("");
            setEditing(true);
          }}
          className="font-semibold tabular-nums text-ink hover:text-lapis-text"
          title={t("canvas.jumpTitle")}
        >
          {t("canvas.pageJump", { page })}
        </button>
      )}
      <span className="text-ink-3">/ {pageCount}</span>
      {label && <span className="border-s border-rule ps-2 text-ink-2">{label}</span>}
    </div>
  );
}

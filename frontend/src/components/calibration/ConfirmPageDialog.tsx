import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DIALOG_PRIMARY, DIALOG_SECONDARY, SatrDialog } from "@/components/app/SatrDialog";
import type { PageException } from "@/lib/calibration/model";

import { exceptionKey, problemKey } from "./labels";

/** How many exceptions the dialog lists before summing up the rest. */
const LISTED = 30;

/**
 * The last gate before a page is approved.
 *
 * Confirmation is of the whole page — never only of what was flagged, because an
 * unflagged blob is not thereby right — and it is the one act that changes things
 * outside this editor: the page's words are written, and its blobs become the
 * examples later pages are read against. So it says both, and lists what still
 * disagrees with the text for the reviewer to acknowledge by hand.
 */
export function ConfirmPageDialog({
  open,
  onOpenChange,
  page,
  exceptions,
  teaches,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: number;
  exceptions: PageException[];
  /** What confirming would teach later pages — see `teaches` in the model. */
  teaches: { bodies: number; marks: number; typed: number };
  pending: boolean;
  onConfirm: (acknowledge: boolean) => void;
}) {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  const needed = exceptions.length > 0;
  // Every opening starts with nothing acknowledged.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  const problem = (kind: string) => {
    const key = problemKey(kind);
    return key ? t(key) : kind;
  };
  const exception = (value: string) => {
    const key = exceptionKey(value);
    return key ? t(key) : value;
  };

  return (
    <SatrDialog
      open={open}
      onOpenChange={(next) => !pending && onOpenChange(next)}
      title={t("calibration.confirmTitle", { page })}
      description={t("calibration.confirmIntro")}
      width={640}
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className={DIALOG_SECONDARY}
          >
            {t("calibration.confirmKeepEditing")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(needed)}
            disabled={pending || (needed && !acknowledged)}
            className={DIALOG_PRIMARY}
          >
            {pending ? t("calibration.confirming") : t("calibration.confirmButton")}
          </button>
        </>
      }
    >
      <Point n={1}>
        <span className="text-[14px] leading-normal">{t("calibration.confirmWords")}</span>
      </Point>
      <Point n={2}>
        <span className="flex flex-col gap-2">
          <span className="text-[14px] leading-normal">{t("calibration.confirmTeachesLead")}</span>
          <span className="flex flex-wrap gap-2">
            <Tile value={teaches.bodies} label={t("calibration.confirmTeachBodies")} />
            <Tile value={teaches.marks} label={t("calibration.confirmTeachMarks")} mark />
            <Tile value={teaches.typed} label={t("calibration.confirmTeachTyped")} />
          </span>
          <span className="text-[12.5px] text-ink-3">{t("calibration.confirmTeachesNote")}</span>
        </span>
      </Point>

      {needed ? (
        <>
          <div className="flex flex-col overflow-hidden rounded-card border border-warn">
            <div className="bg-warn-wash px-3.5 py-2.5 text-[13.5px] font-semibold text-warn-text">
              {t("calibration.confirmExceptions", { count: exceptions.length })}
            </div>
            <ul className="m-0 flex max-h-56 list-none flex-col overflow-y-auto p-0">
              {exceptions.slice(0, LISTED).map((item, index) => (
                <li
                  key={`${item.kind}-${item.line_number}-${index}`}
                  className="flex items-center gap-3 border-b border-rule-soft px-3.5 py-2.5 last:border-b-0"
                >
                  <span className="flex-none rounded bg-sunk px-2 py-px text-[12px] font-semibold">
                    {problem(item.kind)}
                  </span>
                  <span dir="auto" className="min-w-0 text-[13px] text-ink-2">
                    {t("words.onLine", { n: item.line_number })}
                    {item.detail &&
                      ` · ${item.kind === "flagged" ? exception(item.detail) : item.detail}`}
                  </span>
                </li>
              ))}
              {exceptions.length > LISTED && (
                <li className="px-3.5 py-2.5 text-[12.5px] text-ink-3">
                  {t("calibration.moreExceptions", { count: exceptions.length - LISTED })}
                </li>
              )}
            </ul>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-card bg-sheet px-3.5 py-3 text-[14px] font-semibold">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={pending}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="h-[18px] w-[18px] flex-none cursor-pointer accent-lapis"
            />
            {t("calibration.confirmAcknowledge")}
          </label>
        </>
      ) : (
        <p className="m-0 text-[13.5px] font-semibold text-done-text">
          {t("calibration.confirmClean")}
        </p>
      )}
    </SatrDialog>
  );
}

/** One of the two things confirming does, numbered in a lapis square. */
function Point({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-lapis-wash text-[13px] font-bold text-lapis-text">
        {n}
      </span>
      {children}
    </div>
  );
}

/** What the page teaches: a count in Reem Kufi; the marks' in their colour. */
function Tile({ value, label, mark }: { value: number; label: string; mark?: boolean }) {
  const { i18n } = useTranslation();
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-lg px-2.5 py-1.5 ${mark ? "" : "bg-sheet"}`}
      style={mark ? { background: "rgba(40, 180, 200, 0.14)" } : undefined}
    >
      <strong className={`font-display text-[18px] ${mark ? "text-mark-text" : ""}`}>
        {value.toLocaleString(i18n.language)}
      </strong>
      <span className="text-[12.5px] text-ink-2">{label}</span>
    </span>
  );
}

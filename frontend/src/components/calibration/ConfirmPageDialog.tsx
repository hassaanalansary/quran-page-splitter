import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PageException } from "@/lib/calibration/model";

import { exceptionKey, problemKey } from "./labels";

/** How many exceptions the dialog lists before summing up the rest. */
const LISTED = 30;

/**
 * The last gate before a page is approved.
 *
 * Confirmation is of the whole page — never only of what was flagged, because an
 * unflagged blob is not thereby right — and it is the one act that changes things
 * outside this editor: the page's word cuts are replaced, and its blobs become the
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
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {/* Inside the content, so it unmounts on close and every opening starts
            with nothing acknowledged. */}
        <ConfirmBody
          page={page}
          exceptions={exceptions}
          teaches={teaches}
          pending={pending}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmBody({
  page,
  exceptions,
  teaches,
  pending,
  onCancel,
  onConfirm,
}: {
  page: number;
  exceptions: PageException[];
  teaches: { bodies: number; marks: number; typed: number };
  pending: boolean;
  onCancel: () => void;
  onConfirm: (acknowledge: boolean) => void;
}) {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  const needed = exceptions.length > 0;
  const problem = (kind: string) => {
    const key = problemKey(kind);
    return key ? t(key) : kind;
  };
  const exception = (value: string) => {
    const key = exceptionKey(value);
    return key ? t(key) : value;
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("calibration.confirmTitle", { page })}</DialogTitle>
        <DialogDescription>{t("calibration.confirmIntro")}</DialogDescription>
      </DialogHeader>

      <ul className="flex list-disc flex-col gap-1 ps-5 text-[12.5px] leading-relaxed text-text-secondary">
        <li>{t("calibration.confirmWords")}</li>
        <li>{t("calibration.confirmTeaches", teaches)}</li>
      </ul>

      {needed ? (
        <div className="flex flex-col gap-2 rounded-md border border-[color:var(--warning-border)] bg-warning-bg p-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-[#8a4b0d]">
            <TriangleAlert size={14} className="flex-none" />
            {t("calibration.confirmExceptions", { count: exceptions.length })}
          </div>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[11.5px] text-text-secondary">
            {exceptions.slice(0, LISTED).map((item, index) => (
              <li key={`${item.kind}-${item.line_number}-${index}`}>
                <span className="font-semibold">{problem(item.kind)}</span>
                {` · ${t("words.onLine", { n: item.line_number })}`}
                {item.detail &&
                  ` — ${item.kind === "flagged" ? exception(item.detail) : item.detail}`}
              </li>
            ))}
            {exceptions.length > LISTED && (
              <li className="text-text-muted">
                {t("calibration.moreExceptions", { count: exceptions.length - LISTED })}
              </li>
            )}
          </ul>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-text-primary">
            <Checkbox
              className="mt-0.5"
              checked={acknowledged}
              disabled={pending}
              onCheckedChange={(value) => setAcknowledged(value === true)}
            />
            {t("calibration.confirmAcknowledge")}
          </label>
        </div>
      ) : (
        <p className="text-[12px] text-success">{t("calibration.confirmClean")}</p>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {t("common.cancel")}
        </Button>
        <Button onClick={() => onConfirm(needed)} disabled={pending || (needed && !acknowledged)}>
          {pending ? t("calibration.confirming") : t("calibration.confirmButton")}
        </Button>
      </DialogFooter>
    </>
  );
}

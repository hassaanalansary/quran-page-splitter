import { OctagonX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProcessJob } from "@/lib/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  job: ProcessJob;
};

/** Confirmation before stopping a run, of either kind.
 *
 * Stopping loses no saved work, but it does end something the user waited for —
 * and on a long range the cost of an accidental click is minutes of detection.
 * So the dialog's job is not to warn: it is to state the ledger plainly (what is
 * already banked, where it will stop, that it can be resumed) so the decision is
 * made with the numbers in view.
 *
 * A word run counts **lines**, and `pages_saved` stays zero for the whole of it —
 * so the same three rows read against `lines_done` instead. It also has no resume
 * page to offer: it stops at the next chunk boundary, and picking it back up means
 * running the remaining ayat, not the remaining pages. */
export function ProcessCancelDialog({ open, onOpenChange, onConfirm, job }: Props) {
  const { t } = useTranslation();
  const words = job.kind === "words";
  const done = words ? job.lines_done : job.pages_saved;
  const remaining = Math.max(0, job.total - done);
  const resumeFrom = job.current_page ?? job.page_range_start + job.pages_saved;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <OctagonX size={17} className="text-error" />
            {t("process.cancelConfirmTitle")}
          </DialogTitle>
          <DialogDescription>{t("process.cancelConfirmIntro")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          <div className="rounded-md border border-border bg-bg-surface px-3 py-2.5">
            <Row
              label={words ? t("words.cancelSaved") : t("process.cancelConfirmSaved")}
              value={String(done)}
              good
            />
            <Row
              label={words ? t("words.cancelRemaining") : t("process.cancelConfirmRemaining")}
              value={String(remaining)}
              last={words}
            />
            {!words && (
              <Row label={t("process.cancelConfirmResume")} value={String(resumeFrom)} last />
            )}
          </div>
          <p className="text-[12px] leading-[1.55] text-text-secondary">
            {words ? t("words.cancelBody") : t("process.cancelConfirmBody", { page: resumeFrom })}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("process.cancelConfirmKeep")}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            className="bg-error text-white hover:brightness-95"
          >
            {t("process.cancelConfirmStop")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  good,
  last,
}: {
  label: string;
  value: string;
  good?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 text-[12.5px] ${
        last ? "" : "mb-1.5 border-b border-border pb-1.5"
      }`}
    >
      <span className="text-text-secondary">{label}</span>
      <span className={`font-mono font-semibold ${good ? "text-success" : "text-text-primary"}`}>
        {value}
      </span>
    </div>
  );
}

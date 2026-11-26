import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";

import { DIALOG_PRIMARY, SatrDialogFrame } from "@/components/app/SatrDialog";
import { isJobQueued, type ProcessJob } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  job: ProcessJob;
};

/** Confirmation before stopping a detection run.
 *
 * Stopping loses no saved work, but it does end something the user waited for —
 * and on a long range the cost of an accidental click is minutes of detection.
 * So the dialog's job is not to warn: it is to state the ledger plainly (what is
 * already banked, what is left, where it would resume) so the decision is made
 * with the numbers in view. */
export function ProcessCancelDialog({ open, onOpenChange, onConfirm, job }: Props) {
  const { t } = useTranslation();
  // A queued job has done nothing: there is no ledger to show, only that it leaves the queue.
  const queued = isJobQueued(job);
  const done = job.pages_saved;
  const remaining = Math.max(0, job.total - done);
  const resumeFrom = job.current_page ?? job.page_range_start + job.pages_saved;

  return (
    <SatrDialogFrame open={open} onOpenChange={onOpenChange} width={520}>
      <div className="flex flex-col gap-2.5 px-[22px] py-[18px]">
        <DialogPrimitive.Title className="m-0 font-display text-[21px] font-semibold leading-tight">
          {t("process.cancelConfirmTitle")}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="m-0 text-[13.5px] leading-normal text-ink-2">
          {queued ? t("process.cancelQueuedIntro") : t("process.cancelConfirmIntro")}
        </DialogPrimitive.Description>
        {!queued && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Tile value={String(done)} label={t("process.cancelConfirmSaved")} tone="done" />
              <Tile value={String(remaining)} label={t("process.cancelConfirmRemaining")} />
              <Tile
                value={t("process.pageShort", { page: resumeFrom })}
                label={t("process.cancelConfirmResume")}
                tone="lapis"
              />
            </div>
            <p className="m-0 text-[12.5px] leading-normal text-ink-3">
              {t("process.cancelConfirmBody", { page: resumeFrom })}
            </p>
          </>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 bg-sheet px-[22px] py-3">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className={cn(DIALOG_PRIMARY, "h-10 px-4 text-[13.5px]")}
        >
          {t("process.cancelConfirmKeep")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-control border-[1.5px] border-stop bg-transparent px-4 text-[13.5px] font-semibold text-stop-text transition-colors hover:bg-stop-wash"
        >
          {t("process.cancelConfirmStop")}
        </button>
      </div>
    </SatrDialogFrame>
  );
}

/** One figure of the ledger: a number in Reem Kufi over what it counts. */
function Tile({ value, label, tone }: { value: string; label: string; tone?: "done" | "lapis" }) {
  const shell = tone === "done" ? "bg-done-wash" : tone === "lapis" ? "bg-lapis-wash" : "bg-sunk";
  const figure =
    tone === "done" ? "text-done-text" : tone === "lapis" ? "text-lapis-text" : "text-ink";
  return (
    <div className={`flex flex-col rounded-lg px-3 py-2.5 ${shell}`}>
      <span className={`font-display text-[22px] font-semibold leading-tight ${figure}`}>
        {value}
      </span>
      <span className="text-[12px] leading-snug text-ink-2">{label}</span>
    </div>
  );
}

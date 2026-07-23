import { CircleAlert, OctagonAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AbortDiagnostics } from "@/components/app/AbortDiagnostics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AbortInfo } from "@/lib/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `abort` = the detector stopped on a page; `error` = the request itself failed. */
  kind: "abort" | "error";
  /** Detection diagnostics; a run can abort without them. */
  info?: AbortInfo | null;
  /** Logical page detection stopped on (abort only). */
  page?: number | null;
  /** Logical pages actually written before the stop. */
  pagesSaved: number;
  logUrl?: string | null;
  /** Server/network message for a failed request. */
  errorMessage?: string | null;
  /** Sets the start page to the aborted page so the user can pick up there. */
  onResume?: () => void;
};

/** A run that stops is the moment the user most needs to see something — the
 * panel card sits above a long settings list and is easy to miss, so the same
 * information is thrown up front and centre: what stopped it, what usually
 * fixes it, then the per-line detection evidence. */
export function ProcessAbortDialog({
  open,
  onOpenChange,
  kind,
  info,
  page,
  pagesSaved,
  logUrl,
  errorMessage,
  onResume,
}: Props) {
  const { t } = useTranslation();
  const isError = kind === "error";
  const fixes = [
    t("process.abortFix1"),
    t("process.abortFix2"),
    t("process.abortFix3"),
    t("process.abortFix4"),
    t("process.abortFix5"),
    t("process.abortFix6"),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-error">
            {isError ? <OctagonAlert size={18} /> : <CircleAlert size={18} />}
            {isError
              ? t("process.errorDialogTitle")
              : t("process.abortDialogTitle", { page: page ?? "?" })}
          </DialogTitle>
        </DialogHeader>

        {isError ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] leading-[1.6] text-text-secondary">
              {t("process.errorLead")}
            </p>
            {errorMessage && (
              <div className="rounded-md border border-error-border bg-error-bg px-3 py-2.5 font-mono text-[12px] leading-[1.5] text-error">
                {errorMessage}
              </div>
            )}
            <p className="text-[12px] text-text-muted">
              {t("process.progress", { done: pagesSaved, total: pagesSaved })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-error-border bg-error-bg px-3 py-2.5 text-[12.5px] leading-[1.6] text-error">
              <div>{t("process.abortLead", { page: page ?? "?" })}</div>
              <div className="mt-1.5 font-mono text-[11.5px]">
                {info && (
                  <>
                    {t("process.abortCounts", {
                      expected: info.expected_lines ?? "?",
                      detected: info.detected_slots ?? info.detected_lines ?? "?",
                    })}
                    {" · "}
                  </>
                )}
                {t("process.abortSavedCount", { count: pagesSaved })}
              </div>
            </div>

            <div className="rounded-md border border-border bg-bg-surface p-3">
              <div className="mb-2 text-[11.5px] font-semibold tracking-[0.03em] text-text-secondary">
                {t("process.abortFixTitle")}
              </div>
              <ul className="flex flex-col gap-1.5">
                {fixes.map((fix, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[12px] leading-[1.55] text-text-secondary"
                  >
                    <span className="mt-[2px] flex h-4 w-4 flex-none items-center justify-center rounded-full border border-border-strong text-[9px] font-semibold text-text-muted">
                      {i + 1}
                    </span>
                    <span>{fix}</span>
                  </li>
                ))}
              </ul>
            </div>

            {info && <AbortDiagnostics info={info} logUrl={logUrl} />}
          </div>
        )}

        <DialogFooter>
          {onResume && page != null && (
            <Button type="button" variant="outline" onClick={onResume}>
              {t("process.abortResume", { page })}
            </Button>
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

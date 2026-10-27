import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CircleAlert, Download, OctagonAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AbortDiagnostics } from "@/components/app/AbortDiagnostics";
import {
  DIALOG_PRIMARY,
  DIALOG_SECONDARY,
  SatrDialogClose,
  SatrDialogFrame,
} from "@/components/app/SatrDialog";
import type { AbortInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

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

const FIXES = [1, 2, 3, 4, 5, 6] as const;

/** A run that stops is the moment the user most needs to see something — the
 * panel card sits above a long settings list and is easy to miss, so the same
 * information is thrown up front and centre: what stopped it in three figures,
 * the lines it found, and what usually fixes it. A failed request is the short
 * form: what happened and the server's message. */
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
  const button = "h-[42px] px-4";

  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-rule-soft bg-sheet px-7 py-4">
      {logUrl && (
        <a
          href={logUrl}
          target="_blank"
          rel="noreferrer"
          className="me-auto inline-flex h-[42px] items-center gap-2 rounded-control px-3 text-[14px] font-semibold text-lapis-text no-underline hover:underline"
        >
          <Download size={15} aria-hidden="true" />
          {t("process.abortDownloadLog")}
        </a>
      )}
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        className={cn(DIALOG_SECONDARY, button)}
      >
        {t("common.close")}
      </button>
      {onResume && page != null && (
        <button type="button" onClick={onResume} className={cn(DIALOG_PRIMARY, button)}>
          {t("process.abortResume", { page })}
        </button>
      )}
    </div>
  );

  return (
    <SatrDialogFrame open={open} onOpenChange={onOpenChange} width={isError ? 560 : 900}>
      <div className="h-1.5 flex-none bg-stop" />
      <div className="flex items-start gap-4 px-7 pb-2 pt-[22px]">
        <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-stop-wash text-stop-text">
          {isError ? (
            <OctagonAlert size={22} aria-hidden="true" />
          ) : (
            <CircleAlert size={22} aria-hidden="true" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <DialogPrimitive.Title className="m-0 font-display text-[28px] font-semibold leading-tight">
            {isError
              ? t("process.errorDialogTitle")
              : t("process.abortDialogTitle", { page: page ?? "?" })}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="m-0 text-[14.5px] leading-normal text-ink-2">
            {isError ? t("process.errorLead") : t("process.abortLead", { page: page ?? "?" })}
          </DialogPrimitive.Description>
        </div>
        <SatrDialogClose />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isError ? (
          <div className="flex flex-col gap-2.5 px-7 pb-[22px] pt-2">
            {errorMessage && (
              <pre className="m-0 whitespace-pre-wrap rounded-lg border border-rule-soft bg-sheet px-3 py-2.5 font-mono text-[12.5px] leading-normal text-stop-text">
                {errorMessage}
              </pre>
            )}
            <p className="m-0 text-[12.5px] text-ink-3">
              {t("process.abortSavedCount", { count: pagesSaved })}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 px-7 pb-1 pt-3">
              {info && (
                <>
                  <Figure value={info.expected_lines ?? "?"} label={t("process.abortExpected")} />
                  <Figure
                    value={info.detected_slots ?? info.detected_lines ?? "?"}
                    label={t("process.abortDetected", { page: page ?? "?" })}
                    tone="stop"
                  />
                </>
              )}
              <Figure value={pagesSaved} label={t("process.abortSavedBefore")} tone="done" />
            </div>

            <div className="flex flex-wrap gap-x-7 gap-y-[22px] px-7 pb-[22px] pt-[18px]">
              {info && (
                <div className="flex min-w-0 flex-[1_1_340px] flex-col">
                  <AbortDiagnostics info={info} />
                </div>
              )}
              <section className="flex flex-[1_1_340px] flex-col gap-2.5">
                <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                  {t("process.abortFixTitle")}
                </h3>
                {FIXES.map((n) => (
                  <div
                    key={n}
                    className="flex gap-3 rounded-lg px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--rule-soft)]"
                  >
                    <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-sunk text-[11.5px] font-bold text-ink-2">
                      {n}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <strong className="text-[13.5px]">{t(`process.abortFix${n}Title`)}</strong>
                      <span className="text-[12.5px] leading-[1.45] text-ink-2">
                        {t(`process.abortFix${n}Body`)}
                      </span>
                    </span>
                  </div>
                ))}
              </section>
            </div>
          </>
        )}
      </div>

      {actions}
    </SatrDialogFrame>
  );
}

/** A figure of the stop: a number in Reem Kufi beside what it counts. */
function Figure({
  value,
  label,
  tone,
}: {
  value: number | string;
  label: string;
  tone?: "stop" | "done";
}) {
  const shell =
    tone === "stop"
      ? "bg-stop-wash text-stop-text"
      : tone === "done"
        ? "bg-done-wash text-done-text"
        : "bg-sheet";
  return (
    <div className={`flex items-baseline gap-2.5 rounded-card px-4 py-3 ${shell}`}>
      <span className="font-display text-[34px] font-semibold leading-none">{value}</span>
      <span className={`text-[13px] ${tone ? "" : "text-ink-3"}`}>{label}</span>
    </div>
  );
}

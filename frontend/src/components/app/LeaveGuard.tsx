import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useBlocker } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DIALOG_PRIMARY, SatrDialogFrame } from "@/components/app/SatrDialog";
import { cn } from "@/lib/utils";

/** Where a navigation starts or ends, as the guard is asked about it. */
type Place = { pathname: string; search: unknown };

/**
 * Asks before unsaved work is left behind: Review, Lines and Ink. A move the step
 * handles itself (another page of Review, say) passes; anything else waits on
 * the dialog this returns, which the step renders. Closing the tab still gets the
 * browser's own prompt, the only one a page may show there.
 *
 * `dirty` is read when a navigation is tried, so a ref's current value is fine.
 * `leaves` says whether a move leaves the work (the default: another route).
 */
export function useLeaveGuard({
  dirty,
  leaves = (current, next) => current.pathname !== next.pathname,
  body,
}: {
  dirty: () => boolean;
  leaves?: (current: Place, next: Place) => boolean;
  body: string;
}): ReactNode {
  const { t } = useTranslation();
  const blocker = useBlocker({
    enableBeforeUnload: () => dirty(),
    shouldBlockFn: ({ current, next }) => dirty() && leaves(current, next),
    withResolver: true,
  });
  const open = blocker.status === "blocked";

  return (
    <SatrDialogFrame open={open} onOpenChange={(next) => !next && blocker.reset?.()} width={460}>
      <div className="flex gap-3.5 px-[22px] py-[18px]">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-warn-wash text-warn-text">
          <TriangleAlert size={19} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <DialogPrimitive.Title className="m-0 font-display text-[21px] font-semibold leading-tight">
            {t("common.leaveTitle")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="m-0 text-[13.5px] leading-normal text-ink-2">
            {body}
          </DialogPrimitive.Description>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 bg-sheet px-[22px] py-3">
        <button
          type="button"
          onClick={() => blocker.proceed?.()}
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card px-4 text-[13.5px] font-semibold text-stop-text transition-colors hover:bg-stop-wash"
        >
          {t("common.leaveAnyway")}
        </button>
        <button
          type="button"
          onClick={() => blocker.reset?.()}
          className={cn(DIALOG_PRIMARY, "h-10 px-4 text-[13.5px]")}
        >
          {t("common.keepEditing")}
        </button>
      </div>
    </SatrDialogFrame>
  );
}

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { OrnamentStrip } from "@/components/app/Ornament";
import { cn } from "@/lib/utils";

/** A dialog's footer buttons: 44 px, secondary outlined, primary lapis or --stop. */
export const DIALOG_SECONDARY =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card px-[18px] text-[14px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-60";
export const DIALOG_PRIMARY =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-control bg-lapis px-5 text-[14px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-60";
export const DIALOG_DESTRUCTIVE =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-control bg-stop px-5 text-[14px] font-semibold text-on-stop transition-colors hover:bg-stop/90 disabled:cursor-default disabled:opacity-60";

/** The bare dialog: scrim, a card of radius 14 at most `width` wide, and whatever
 * the dialog lays out inside. The dialogs with their own anatomy (the run's log,
 * a stopped run, the cut preview) are built on it; title them with
 * `DialogPrimitive.Title`. */
export function SatrDialogFrame({
  open,
  onOpenChange,
  width,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width: number;
  onCloseAutoFocus?: (e: Event) => void;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          style={{ maxWidth: width }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] bg-card text-ink shadow-[var(--shadow-modal)] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The dialog's close button: an X, 36 px. `className` recolours it (on deep lapis). */
export function SatrDialogClose({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Close
      aria-label={t("common.close")}
      className={cn(
        "flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-sheet hover:text-ink",
        className,
      )}
    >
      <X className="h-[18px] w-[18px]" aria-hidden="true" />
    </DialogPrimitive.Close>
  );
}

/**
 * A form dialog in the Tablet look: the ornament strip on deep lapis along the top,
 * a Reem Kufi title with its line beneath, a close button, then the body. The body
 * scrolls when the window is short; `footer` stays at the bottom, actions at the end.
 */
export function SatrDialog({
  open,
  onOpenChange,
  title,
  description,
  width = 580,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SatrDialogFrame open={open} onOpenChange={onOpenChange} width={width}>
      <OrnamentStrip height={8} className="bg-deep" />
      <div className="flex items-start gap-4 px-7 pb-1.5 pt-6">
        <div className="flex flex-1 flex-col gap-1.5">
          <DialogPrimitive.Title className="m-0 font-display text-[28px] font-semibold leading-tight">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="m-0 text-[14.5px] leading-normal text-ink-2">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
        </div>
        <SatrDialogClose />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-7 pb-2 pt-[18px]">
        {children}
      </div>
      {footer && (
        <div className="mx-7 mb-6 mt-3 flex flex-wrap justify-end gap-2.5 border-t border-rule-soft pt-4">
          {footer}
        </div>
      )}
    </SatrDialogFrame>
  );
}

/**
 * A confirmation that cannot be undone: a --stop rule on top, the icon in a stop
 * wash beside the title, and the actions on a sheet band at the bottom.
 */
export function SatrConfirmDialog({
  open,
  onOpenChange,
  icon,
  title,
  body,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  title: string;
  body: string;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SatrDialogFrame open={open} onOpenChange={onOpenChange} width={460}>
      <div className="h-[5px] flex-none bg-stop" />
      <div className="flex gap-3.5 px-[22px] py-[18px]">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-stop-wash text-stop-text">
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <DialogPrimitive.Title className="m-0 font-display text-[21px] font-semibold leading-tight">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="m-0 text-[13.5px] leading-normal text-ink-2">
            {body}
          </DialogPrimitive.Description>
          {children}
        </div>
      </div>
      <div className={cn("flex flex-wrap justify-end gap-2 bg-sheet px-[22px] py-3")}>
        {actions}
      </div>
    </SatrDialogFrame>
  );
}

/** A chosen file, as the dialogs show it: a format badge, its name and size, and a
 * button to pick another. */
export function FileCard({
  badge,
  tone,
  name,
  detail,
  action,
}: {
  badge: string;
  tone: "stop" | "lapis";
  name: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 rounded-lg border border-rule-2 bg-sheet px-4 py-3.5">
      <span
        className={cn(
          "flex h-12 w-10 flex-none items-end justify-center rounded pb-2 font-mono text-[11px] font-bold",
          tone === "stop" ? "bg-stop-wash text-stop-text" : "bg-lapis-wash text-lapis-text",
        )}
      >
        {badge}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[14.5px] font-semibold">{name}</span>
        <span dir="ltr" className="self-start font-mono text-[12.5px] text-ink-3">
          {detail}
        </span>
      </span>
      {action}
    </div>
  );
}

/** A dialog's 44 px input or select. */
export const DIALOG_INPUT =
  "h-11 w-full rounded-control border border-rule-2 bg-card px-3.5 text-[15px] text-ink outline-none transition-colors focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)] disabled:cursor-not-allowed disabled:opacity-60";

/** A labelled field in a dialog, with an optional hint under it. */
export function DialogField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-2">
        {label}
      </label>
      {children}
      {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
    </div>
  );
}

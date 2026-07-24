import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Dismiss the toast a click landed inside by triggering its own close button —
 * sonner keeps ownership of the exit animation and `onDismiss` callbacks, and no
 * call site has to hold on to the toast id. Sonner has no click-to-dismiss of
 * its own, so this rides on the button `closeButton` renders.
 */
function dismissOnClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement | null;
  const toast = target?.closest<HTMLElement>("[data-sonner-toast]");
  if (!toast || toast.dataset.dismissible === "false") return;
  // Buttons and links inside a toast (close, action, cancel) keep their own click.
  if (target?.closest("button, a")) return;
  // Don't yank the toast away mid-selection — error text is worth copying.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && toast.contains(selection.anchorNode)) return;
  toast.querySelector<HTMLButtonElement>("[data-close-button]")?.click();
}

const CLASS_NAMES: NonNullable<NonNullable<ToasterProps["toastOptions"]>["classNames"]> = {
  toast:
    "group toast cursor-pointer group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
  description: "group-[.toast]:text-muted-foreground",
  actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
  cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
  closeButton: "cursor-pointer",
};

const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  return (
    <div style={{ display: "contents" }} onClick={dismissOnClick}>
      <Sonner
        className="toaster group"
        closeButton
        {...props}
        toastOptions={{
          ...toastOptions,
          classNames: { ...CLASS_NAMES, ...toastOptions?.classNames },
        }}
      />
    </div>
  );
};

export { Toaster };

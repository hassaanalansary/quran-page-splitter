import { CircleAlert } from "lucide-react";
import type { CSSProperties } from "react";
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
    "group toast cursor-pointer !gap-3 !rounded-[10px] !px-3.5 !py-3 !text-[13.5px] !shadow-[var(--shadow-card)]",
  error: "!font-medium",
  description: "!text-current opacity-80",
  actionButton: "!bg-transparent !font-bold !text-current underline-offset-2 hover:underline",
  cancelButton: "!bg-transparent !text-current opacity-80",
  closeButton: "cursor-pointer",
};

/** The toasts as the board draws them: the inverse colours with a dot in the
 * colour of what happened, and a failure on the stop wash. Sonner reads its
 * colours from these variables, set on the toaster itself so they win over its
 * own. */
const COLOURS = {
  "--border-radius": "10px",
  "--normal-bg": "var(--toast)",
  "--normal-text": "var(--on-toast)",
  "--normal-border": "transparent",
  "--success-bg": "var(--toast)",
  "--success-text": "var(--on-toast)",
  "--success-border": "transparent",
  "--info-bg": "var(--toast)",
  "--info-text": "var(--on-toast)",
  "--info-border": "transparent",
  "--warning-bg": "var(--toast)",
  "--warning-text": "var(--on-toast)",
  "--warning-border": "transparent",
  "--error-bg": "var(--stop-wash)",
  "--error-text": "var(--stop-text)",
  "--error-border": "transparent",
} as CSSProperties;

function Dot({ colour }: { colour: string }) {
  return (
    <span
      aria-hidden="true"
      className="block h-[9px] w-[9px] rounded-full"
      style={{ background: colour }}
    />
  );
}

const ICONS: ToasterProps["icons"] = {
  success: <Dot colour="var(--on-toast-done)" />,
  info: <Dot colour="var(--on-toast-info)" />,
  warning: <Dot colour="var(--on-toast-warn)" />,
  error: <CircleAlert size={17} aria-hidden="true" />,
};

const Toaster = ({ toastOptions, style, ...props }: ToasterProps) => {
  return (
    <div style={{ display: "contents" }} onClick={dismissOnClick}>
      <Sonner
        className="toaster group"
        closeButton
        richColors
        icons={ICONS}
        {...props}
        style={{ ...COLOURS, ...style }}
        toastOptions={{
          ...toastOptions,
          classNames: { ...CLASS_NAMES, ...toastOptions?.classNames },
        }}
      />
    </div>
  );
};

export { Toaster };

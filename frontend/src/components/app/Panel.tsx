import { ChevronDown, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useShellStep } from "@/components/app/shell/context";
import { useOtherLanguage } from "@/hooks/use-other-language";
import { cn } from "@/lib/utils";

import { InfoTip } from "./InfoTip";
import { t } from "i18next";

/** A step's row inside the shell: its canvas, then its {@link Aside}. Stacks on
 * narrow screens, the inspector under the canvas. */
export function StepBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden max-lg:flex-col">{children}</div>
  );
}

/** The step's name, with its other-language twin in gold, atop the inspector. */
function InspectorTitle() {
  const { t } = useTranslation();
  const other = useOtherLanguage();
  const step = useShellStep();
  if (!step) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <h1 className="m-0 font-display text-[28px] font-semibold leading-tight">
        {t(`header.steps.${step}`)}
      </h1>
      <span lang={other.lng} className="font-display text-[18px] text-gold-text">
        {other.t(`header.steps.${step}`)}
      </span>
    </div>
  );
}

/** The shell's inspector, on the end side of every step: the step's title, then
 * the context for what is selected, scrolling. `status` and `footer` are pinned
 * below the scroll area so the next action, a blocker or a warning, and the
 * step's buttons, are never scrolled out of view. 340 px; `wide` for the steps
 * whose boards draw it at 360. */
export function Aside({
  children,
  status,
  footer,
  wide = false,
}: {
  children: ReactNode;
  status?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <aside
      className={cn(
        "flex flex-none flex-col overflow-hidden border-s border-rule bg-sheet max-lg:max-h-[45%] max-lg:w-full max-lg:border-s-0 max-lg:border-t",
        wide ? "lg:w-[360px]" : "lg:w-[340px]",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-5">
        <InspectorTitle />
        {children}
      </div>
      {(status || footer) && (
        <div className="flex flex-none flex-col gap-3 border-t border-rule px-5 pb-[18px] pt-3.5">
          {status}
          {footer}
        </div>
      )}
    </aside>
  );
}

export function PanelCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-rule bg-card p-4">
      <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A collapsible titled section, for dividing a long control panel. */
export function Section({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-card border border-rule bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 rounded-card px-4 py-3 text-start transition-colors hover:bg-sheet focus:outline-none focus-visible:ring-2 focus-visible:ring-lapis"
      >
        <span className="flex-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {title}
        </span>
        {badge}
        <ChevronDown
          size={15}
          className={`flex-shrink-0 text-ink-3 transition-transform ${open ? "" : "-rotate-90 rtl:rotate-90"}`}
        />
      </button>
      {open && <div className="flex flex-col gap-3 px-4 pb-4">{children}</div>}
    </section>
  );
}

export function Field({
  label,
  hint,
  info,
  children,
}: {
  label: string;
  hint?: string;
  info?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-[11.5px] font-semibold tracking-[0.03em] text-ink-2">
        {label}
        {info && <InfoTip text={info} />}
      </span>
      {children}
      {hint && <span className="text-[10.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Hint({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  const styles =
    tone === "warning"
      ? "border-warn/25 bg-warn-wash text-warn-text"
      : "border-rule bg-sheet text-ink-2";
  return (
    <div className={`rounded-md border px-3 py-2 text-[12px] leading-[1.5] ${styles}`}>
      {children}
    </div>
  );
}

/** A compact single-line next-action / blocker indicator for the pinned `status`
 * slot of {@link Aside} — a coloured dot plus a short message. */
export function StatusLine({
  tone = "action",
  children,
}: {
  tone?: "action" | "info" | "warning" | "success" | "error";
  children: ReactNode;
}) {
  const dot =
    tone === "warning"
      ? "bg-warn"
      : tone === "error"
        ? "bg-stop"
        : tone === "success"
          ? "bg-done"
          : tone === "info"
            ? "bg-lapis"
            : "bg-gold";
  const text =
    tone === "warning"
      ? "text-warn-text"
      : tone === "error"
        ? "text-stop-text"
        : tone === "success"
          ? "text-done-text"
          : tone === "info"
            ? "text-lapis-text"
            : "text-gold-text";
  return (
    <div className={`flex items-center gap-2 text-[13px] ${text}`}>
      <span className={`h-[7px] w-[7px] flex-none rounded-full ${dot}`} aria-hidden />
      <span className="leading-snug">{children}</span>
    </div>
  );
}

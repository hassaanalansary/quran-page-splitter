import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { InfoTip } from "./InfoTip";

/** Right-hand control column used by the setup / templates / process steps.
 * `status` is pinned above `footer` (outside the scroll area) so the current
 * next-action / blocker / warning is never scrolled out of view. */
export function Aside({
  children,
  status,
  footer,
}: {
  children: ReactNode;
  status?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside className="flex w-[340px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-white">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
      {(status || footer) && (
        <div className="flex-shrink-0 border-t border-border">
          {status && <div className="px-4 pt-3">{status}</div>}
          {footer && <div className="p-4">{footer}</div>}
        </div>
      )}
    </aside>
  );
}

export function PanelCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-white">
      <div className="border-b border-border px-3 py-2 text-[12px] font-semibold tracking-[0.02em] text-text-primary">
        {title}
      </div>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </div>
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
    <div className="rounded-md border border-border bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-[12px] font-semibold tracking-[0.02em] text-text-primary transition-colors bg-bg-surface hover:bg-orange-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
      >
        <ChevronDown
          size={14}
          className={`flex-shrink-0 text-text-muted transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="flex-1 text-left text-orange">{title}</span>
        {badge}
      </button>
      {open && <div className="flex flex-col gap-3 border-t border-border p-3">{children}</div>}
    </div>
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
      <span className="flex items-center gap-1 text-[11.5px] font-semibold tracking-[0.03em] text-text-secondary">
        {label}
        {info && <InfoTip text={info} />}
      </span>
      {children}
      {hint && <span className="text-[10.5px] text-text-muted">{hint}</span>}
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
      ? "border-[color:var(--warning-border)] bg-warning-bg text-[#92400E]"
      : "border-border bg-bg-surface text-text-secondary";
  return (
    <div className={`rounded-md border px-3 py-2 text-[12px] leading-[1.5] ${styles}`}>
      {children}
    </div>
  );
}

/** A compact single-line next-action / blocker indicator for the pinned `status`
 * slot of {@link Aside} — a coloured dot plus a short message. */
export function StatusLine({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "success";
  children: ReactNode;
}) {
  const dot = tone === "warning" ? "bg-warning" : tone === "success" ? "bg-success" : "bg-orange";
  const text = tone === "warning" ? "text-[#8a4b0d]" : "text-text-secondary";
  return (
    <div className={`flex items-center gap-2 text-[11.5px] ${text}`}>
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${dot}`} aria-hidden />
      <span className="leading-snug">{children}</span>
    </div>
  );
}

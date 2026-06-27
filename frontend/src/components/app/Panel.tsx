import type { ReactNode } from "react";

/** Right-hand control column used by the setup / templates / process steps. */
export function Aside({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <aside className="flex w-[340px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-white">
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
      {footer && <div className="flex-shrink-0 border-t border-border p-4">{footer}</div>}
    </aside>
  );
}

export function PanelCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-white">
      <div className="border-b border-border px-3 py-2 text-[12px] font-semibold tracking-[0.02em] text-text-primary">
        {title}
      </div>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-semibold tracking-[0.03em] text-text-secondary">
        {label}
      </span>
      {children}
      {hint && <span className="text-[10.5px] text-text-muted">{hint}</span>}
    </label>
  );
}

export function Hint({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" }) {
  const styles =
    tone === "warning"
      ? "border-[color:var(--warning-border)] bg-warning-bg text-[#92400E]"
      : "border-border bg-bg-surface text-text-secondary";
  return (
    <div className={`rounded-md border px-3 py-2 text-[12px] leading-[1.5] ${styles}`}>{children}</div>
  );
}

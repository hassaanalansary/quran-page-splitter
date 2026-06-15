import { Link, useRouterState } from "@tanstack/react-router";

type Step = { label: string; to: "/" | "/verify" | "/finalize" };

const STEPS: Step[] = [
  { label: "Upload", to: "/" },
  { label: "Verify", to: "/verify" },
  { label: "Finalize", to: "/finalize" },
];

export function AppHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <header className="flex h-[60px] flex-shrink-0 items-center gap-5 border-b border-border bg-white px-5">
      <div className="flex items-center gap-[9px]">
        <span className="mt-px h-2 w-2 rounded-[2px] bg-orange" />
        <span
          className="font-display text-[16px] font-bold leading-none text-navy"
          style={{ letterSpacing: "0.01em" }}
        >
          Raqam
        </span>
        <span className="ml-1.5 text-[13px] font-light text-text-secondary">Mushaf Splitter</span>
      </div>

      <nav className="ml-auto flex items-center gap-0">
        {STEPS.map((s, i) => {
          const active = pathname === s.to;
          return (
            <div key={s.label} className="flex items-center">
              <Link
                to={s.to}
                className="flex items-center gap-2 rounded-pill px-3 py-1.5 transition-colors hover:bg-bg-surface"
              >
                <span
                  className={[
                    "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold leading-none",
                    active
                      ? "bg-orange text-white shadow-[0_0_0_4px_var(--orange-glow)]"
                      : "border-2 border-border-strong text-text-muted",
                  ].join(" ")}
                >
                  {i + 1}
                </span>
                <span
                  className={[
                    "text-[12px]",
                    active ? "font-semibold text-orange" : "font-medium text-text-secondary",
                  ].join(" ")}
                >
                  {s.label}
                </span>
              </Link>
              {i < STEPS.length - 1 && <span className="mx-1 h-[2px] w-10 bg-border-strong" />}
            </div>
          );
        })}
      </nav>
    </header>
  );
}

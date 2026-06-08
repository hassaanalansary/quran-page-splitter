type Step = { label: string; state: "done" | "active" | "todo" };

const STEPS: Step[] = [
  { label: "Upload", state: "active" },
  { label: "Review", state: "todo" },
  { label: "Cut Review", state: "todo" },
];

export function AppHeader() {
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
        <span className="ml-1.5 text-[13px] font-light text-text-secondary">
          Mushaf Splitter
        </span>
      </div>

      <nav className="ml-auto flex items-center gap-0">
        {STEPS.map((s, i) => (
          <div key={s.label} className="flex items-center">
            <button
              type="button"
              className="flex items-center gap-2 rounded-pill px-3 py-1.5 transition-colors hover:bg-bg-surface"
            >
              <span
                className={[
                  "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold leading-none",
                  s.state === "active" &&
                    "bg-orange text-white shadow-[0_0_0_4px_var(--orange-glow)]",
                  s.state === "done" && "bg-navy text-white",
                  s.state === "todo" &&
                    "border-2 border-border-strong text-text-muted",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {s.state === "done" ? "✓" : i + 1}
              </span>
              <span
                className={[
                  "text-[12px]",
                  s.state === "active" && "font-semibold text-orange",
                  s.state === "done" && "font-medium text-navy",
                  s.state === "todo" && "font-medium text-text-muted",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {s.label}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <span
                className={[
                  "mx-1 h-[2px] w-10",
                  s.state === "done" ? "bg-navy-light" : "bg-border-strong",
                ].join(" ")}
              />
            )}
          </div>
        ))}
      </nav>
    </header>
  );
}

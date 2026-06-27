import {
  createFileRoute,
  Link,
  Outlet,
  useParams,
  useRouterState,
} from "@tanstack/react-router";

import { useMushaf } from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId")({ component: WorkspaceLayout });

const STEPS = [
  { slug: "setup", to: "/mushafs/$mushafId/setup", label: "Setup" },
  { slug: "templates", to: "/mushafs/$mushafId/templates", label: "Templates" },
  { slug: "process", to: "/mushafs/$mushafId/process", label: "Process" },
  { slug: "review", to: "/mushafs/$mushafId/review", label: "Review" },
  { slug: "finalize", to: "/mushafs/$mushafId/finalize", label: "Finalize" },
] as const;

function WorkspaceLayout() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId" });
  const { data: mushaf, isPending, isError, error } = useMushaf(mushafId);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSlug = STEPS.find((s) => pathname.endsWith(`/${s.slug}`))?.slug ?? "setup";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-page">
      <header className="flex h-[60px] flex-shrink-0 items-center gap-3 border-b border-border bg-white px-5">
        <Link to="/" className="flex items-center gap-2.5" title="All mushafs">
          <span className="mt-px h-2 w-2 rounded-[2px] bg-orange" />
          <span className="font-display text-[15px] font-bold leading-none text-navy">
            Quran Page Splitter
          </span>
        </Link>
        <span className="text-text-muted">/</span>
        <span className="max-w-[220px] truncate text-[13px] font-medium text-text-primary">
          {mushaf?.name ?? "…"}
        </span>

        <nav className="ml-auto flex items-center gap-1">
          {STEPS.map((step, i) => (
            <Link
              key={step.slug}
              to={step.to}
              params={{ mushafId }}
              className={[
                "flex items-center gap-2 rounded-pill px-2.5 py-1.5 transition-colors hover:bg-bg-surface",
                step.slug === activeSlug ? "bg-bg-surface" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold leading-none",
                  step.slug === activeSlug
                    ? "bg-orange text-white shadow-[0_0_0_3px_var(--orange-glow)]"
                    : "border-2 border-border-strong text-text-muted",
                ].join(" ")}
              >
                {i + 1}
              </span>
              <span
                className={[
                  "text-[12px]",
                  step.slug === activeSlug
                    ? "font-semibold text-orange"
                    : "font-medium text-text-secondary",
                ].join(" ")}
              >
                {step.label}
              </span>
            </Link>
          ))}
        </nav>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {isPending ? (
          <Centered>Loading mushaf…</Centered>
        ) : isError ? (
          <Centered>
            <span className="text-error">
              {error instanceof Error ? error.message : "Failed to load mushaf."}
            </span>
          </Centered>
        ) : (
          <Outlet />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
      {children}
    </div>
  );
}

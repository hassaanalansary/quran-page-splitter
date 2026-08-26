import { createFileRoute, Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { MushafHeader } from "@/components/app/MushafHeader";
import { useMushaf } from "@/lib/api";
import { requireSession } from "@/lib/auth/guard";

export const Route = createFileRoute("/mushafs/$mushafId")({
  component: WorkspaceLayout,
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
});

const STEPS = [
  { slug: "setup" },
  { slug: "templates" },
  { slug: "process" },
  { slug: "review" },
  { slug: "finalize" },
] as const;

function WorkspaceLayout() {
  const { t } = useTranslation();
  const { mushafId } = useParams({ from: "/mushafs/$mushafId" });
  const { data: mushaf, isPending, isError, error } = useMushaf(mushafId);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const step = STEPS.find((s) => pathname.endsWith(`/${s.slug}`));

  // The details hub (the index child) renders its own layout with the shared header.
  if (!step) return <Outlet />;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-page">
      {mushaf ? (
        <MushafHeader mushaf={mushaf} activeSlug={step.slug} />
      ) : (
        <div className="h-[60px] flex-shrink-0 border-b border-border bg-white" />
      )}

      <div className="flex flex-1 overflow-hidden">
        {isPending ? (
          <Centered>{t("workspace.loadingMushaf")}</Centered>
        ) : isError ? (
          <Centered>
            <span className="text-error">
              {error instanceof Error ? error.message : t("workspace.loadFailed")}
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

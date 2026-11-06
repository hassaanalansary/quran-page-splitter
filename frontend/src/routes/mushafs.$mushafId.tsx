import { createFileRoute, Link, Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LoadingState } from "@/components/app/SatrLoader";
import { ErrorState, STATE_SECONDARY } from "@/components/app/States";
import type { StepSlug } from "@/components/app/details/helpers";
import { ShellStepContext } from "@/components/app/shell/context";
import { Spine } from "@/components/app/shell/Spine";
import { WorkspaceTopBar } from "@/components/app/shell/WorkspaceTopBar";
import { useMushaf } from "@/lib/api";
import { requireSession } from "@/lib/auth/guard";

export const Route = createFileRoute("/mushafs/$mushafId")({
  component: WorkspaceLayout,
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
});

const STEPS: StepSlug[] = ["setup", "templates", "process", "review", "finalize", "ink"];

/**
 * The workspace shell every step sits in: the top bar, the spine of steps on the
 * start side, and the step itself, which fills the rest with its canvas and its
 * inspector (Panel's `Aside`). Logical sides throughout, so the whole thing
 * mirrors under Arabic without any step flipping its own row.
 */
function WorkspaceLayout() {
  const { t } = useTranslation();
  const { mushafId } = useParams({ from: "/mushafs/$mushafId" });
  const { data: mushaf, isPending, isError, error } = useMushaf(mushafId);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const step = STEPS.find((slug) => pathname.endsWith(`/${slug}`));

  // The details hub (the index child) renders its own layout and header.
  if (!step) return <Outlet />;

  return (
    <ShellStepContext.Provider value={step}>
      <div className="flex h-screen flex-col overflow-hidden bg-paper">
        <WorkspaceTopBar mushaf={mushaf ?? null} />

        <div className="flex min-h-0 flex-1 overflow-hidden max-lg:flex-col">
          {mushaf ? (
            <>
              <Spine mushaf={mushaf} active={step} />
              <Outlet />
            </>
          ) : isPending ? (
            <Centered>
              <LoadingState>{t("workspace.loadingMushaf")}</LoadingState>
            </Centered>
          ) : isError ? (
            <Centered>
              <ErrorState
                title={t("workspace.loadFailed")}
                body={error instanceof Error ? error.message : undefined}
                className="w-full max-w-[420px]"
              >
                <Link to="/" className={STATE_SECONDARY}>
                  {t("header.allMushafs")}
                </Link>
              </ErrorState>
            </Centered>
          ) : null}
        </div>
      </div>
    </ShellStepContext.Provider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-ink-2">{children}</div>
  );
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ErrorState, NotFoundCard, STATE_PRIMARY, STATE_SECONDARY } from "@/components/app/States";
import { Toaster } from "@/components/ui/sonner";
import { useTheme } from "@/lib/theme";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <NotFoundCard />
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <ErrorState
        title={t("errorPage.title")}
        body={t("errorPage.body")}
        className="w-full max-w-[420px]"
      >
        <button
          type="button"
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className={STATE_PRIMARY}
        >
          {t("errorPage.tryAgain")}
        </button>
        <a href="/" className={STATE_SECONDARY}>
          {t("errorPage.goHome")}
        </a>
      </ErrorState>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const { t } = useTranslation();
  const { theme } = useTheme();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster
        position="top-right"
        theme={theme}
        richColors
        toastOptions={{ closeButtonAriaLabel: t("common.closeToast") }}
      />
    </QueryClientProvider>
  );
}

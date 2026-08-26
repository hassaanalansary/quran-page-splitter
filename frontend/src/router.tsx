import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { queryKeys, setUnauthorizedHandler } from "./lib/api";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // React Query retries three times by default, with backoff. That is
        // right for a flaky network and wrong for a 4xx: someone else's mushaf
        // will still be 404 on the third attempt, and meanwhile the page sits
        // on a loading spinner for seconds before it can show the real answer.
        retry: (failureCount, error) => {
          const status = (error as { status?: number } | null)?.status;
          if (typeof status === "number" && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  // A 401 from the Ninja API means the session ended mid-visit — it expired, or
  // the user signed out in another tab. Mark the session as anonymous so route
  // guards agree, then send them to sign in with a way back.
  //
  // Only /api calls reach here: allauth's own endpoints use their own client in
  // lib/api/auth.ts, because a 401 from /auth/session is the ordinary
  // signed-out answer rather than an error.
  setUnauthorizedHandler(() => {
    queryClient.setQueryData(queryKeys.session, null);
    const current = router.state.location.href;
    if (!current.startsWith("/auth/")) {
      void router.navigate({ to: "/auth/login", search: { next: current } });
    }
  });

  return router;
};

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}

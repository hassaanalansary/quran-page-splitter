import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import { getSession, queryKeys } from "@/lib/api";

/** Route guard: resolve the session before the route loads, bouncing anonymous
 * visitors to sign-in with a `next` so they land back where they were headed.
 *
 * Uses `ensureQueryData` rather than a plain fetch so the guard and the
 * `useSession` hook share one cache entry — navigating between guarded routes
 * costs no extra requests.
 */
export async function requireSession(queryClient: QueryClient, next: string) {
  const user = await queryClient.ensureQueryData({
    queryKey: queryKeys.session,
    queryFn: () => getSession(),
    // Without this, a stale cached value is returned as-is and the guard can
    // act on a session state that has since changed — the classic symptom
    // being a successful sign-in that appears to do nothing.
    revalidateIfStale: true,
  });
  if (!user) {
    throw redirect({ to: "/auth/login", search: { next } });
  }
  return user;
}

/** Guard for `/`, the app's front door.
 *
 * Unlike `requireSession`, an anonymous visitor is sent to the **gallery**
 * rather than to the sign-in form. A stranger arriving at the site has no
 * reason to make an account before seeing what the thing produces, and a
 * login wall left `/gallery` undiscoverable — nothing linked to it except the
 * header of pages you had to sign in to reach.
 *
 * The gallery's own header carries the sign-in button, so the way in stays one
 * click away.
 */
export async function requireSessionOrGallery(queryClient: QueryClient) {
  const user = await queryClient.ensureQueryData({
    queryKey: queryKeys.session,
    queryFn: () => getSession(),
    revalidateIfStale: true,
  });
  if (!user) {
    throw redirect({ to: "/gallery" });
  }
  return user;
}

/** Inverse guard for the /auth/* pages: someone who already has a session has
 * no business on the sign-in form. allauth answers 409 Conflict if they post
 * one anyway (headless/account/views.py: LoginView returns ConflictResponse
 * when request.user.is_authenticated) — which is exactly what you hit after
 * signing in to the Django admin, since the session cookie is shared. */
export async function redirectIfAuthenticated(queryClient: QueryClient, next?: string) {
  const user = await queryClient.ensureQueryData({
    queryKey: queryKeys.session,
    queryFn: () => getSession(),
  });
  if (user) {
    throw redirect({ to: next ?? "/" });
  }
}

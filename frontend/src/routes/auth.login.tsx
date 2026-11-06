import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BusyLabel } from "@/components/app/SatrLoader";
import {
  AuthError as ErrorBanner,
  AuthField,
  AuthHeading,
  AuthShell,
  AuthSubmit,
  GoogleStart,
} from "@/components/app/auth/AuthShell";
import { AuthError, getSession, login, queryKeys, startProviderLogin } from "@/lib/api";
import { redirectIfAuthenticated } from "@/lib/auth/guard";

export const Route = createFileRoute("/auth/login")({
  component: LoginPage,
  beforeLoad: ({ context, search }) => redirectIfAuthenticated(context.queryClient, search.next),
  // Return type annotated so `next` is *optional*, not "required but possibly
  // undefined" — otherwise every <Link to="/auth/login"> has to pass a search.
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
});

function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { next } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => login(email.trim(), password),
    onSuccess: async (user) => {
      // Everything cached was fetched as the previous (or no) user.
      queryClient.clear();
      // Seed the session rather than just invalidating it. The destination's
      // guard reads it with `ensureQueryData`, which returns whatever is
      // cached — including the stale `null` from being signed out, which would
      // bounce us straight back to this page and look like nothing happened.
      queryClient.setQueryData(queryKeys.session, user ?? (await getSession()));
      await navigate({ to: next ?? "/" });
    },
    onError: (e) => {
      // A session can appear between page load and submit — signing in to the
      // Django admin in another tab does it, since the cookie is shared across
      // ports. Follow through rather than showing a bare "409 Conflict".
      if (e instanceof AuthError && e.code === "already_authenticated") {
        void navigate({ to: next ?? "/" });
        return;
      }
      setError(e instanceof AuthError ? e.message : t("auth.errors.generic"));
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="flex flex-col gap-[18px]">
        <AuthHeading title={t("auth.login.title")} subtitle={t("auth.login.subtitle")} />
        <GoogleStart onClick={() => void startProviderLogin("google", next ?? "/")} />
        <AuthField
          id="login-email"
          label={t("auth.emailLabel")}
          type="email"
          autoComplete="email"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <AuthField
          id="login-password"
          label={t("auth.passwordLabel")}
          aside={
            <Link to="/auth/forgot" className="font-semibold text-lapis-text hover:underline">
              {t("auth.login.forgot")}
            </Link>
          }
          type="password"
          autoComplete="current-password"
          dir="ltr"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <ErrorBanner message={error} />}

        <AuthSubmit disabled={mutation.isPending}>
          {mutation.isPending ? <BusyLabel>{t("common.loading")}</BusyLabel> : t("auth.signIn")}
        </AuthSubmit>
        <p className="m-0 mt-1 text-center text-[14px] text-ink-2">
          {t("auth.login.noAccount")}{" "}
          <Link to="/auth/signup" className="font-semibold text-lapis-text hover:underline">
            {t("auth.login.createOne")}
          </Link>
        </p>
        <p className="m-0 text-center text-[13px] text-ink-3">
          {t("auth.login.browseBefore")}{" "}
          <Link to="/gallery" className="text-ink-2 underline-offset-2 hover:underline">
            {t("auth.login.browseLink")}
          </Link>{" "}
          {t("auth.login.browseAfter")}
        </p>
      </form>
    </AuthShell>
  );
}

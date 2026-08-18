import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthError as ErrorBanner, AuthShell, GoogleIcon } from "@/components/app/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <AuthShell
      title={t("auth.login.title")}
      subtitle={t("auth.login.subtitle")}
      footer={
        <>
          {t("auth.login.noAccount")}{" "}
          <Link to="/auth/signup" className="font-medium text-navy hover:underline">
            {t("auth.login.createOne")}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-email">{t("auth.emailLabel")}</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-password">{t("auth.passwordLabel")}</Label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Link
            to="/auth/forgot"
            className="text-xs text-text-secondary hover:text-navy hover:underline"
          >
            {t("auth.login.forgot")}
          </Link>
        </div>

        {error && <ErrorBanner message={error} />}

        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? t("common.loading") : t("auth.signIn")}
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase text-text-muted">{t("auth.or")}</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => void startProviderLogin("google", next ?? "/")}
      >
        <GoogleIcon />
        {t("auth.withGoogle")}
      </Button>
    </AuthShell>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthError as ErrorBanner, AuthShell, GoogleIcon } from "@/components/app/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthError, signup, startProviderLogin } from "@/lib/api";
import { redirectIfAuthenticated } from "@/lib/auth/guard";

export const Route = createFileRoute("/auth/signup")({
  component: SignupPage,
  beforeLoad: ({ context }) => redirectIfAuthenticated(context.queryClient),
});

function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => signup(email.trim(), password),
    onSuccess: async (result) => {
      if (result.verified) {
        // Only reachable if email verification is switched off server-side.
        await queryClient.invalidateQueries();
        navigate({ to: "/" });
        return;
      }
      setSentTo(email.trim());
    },
    onError: (e) => {
      if (e instanceof AuthError && e.code === "already_authenticated") {
        void navigate({ to: "/" });
        return;
      }
      setError(e instanceof AuthError ? e.message : t("auth.errors.generic"));
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // allauth's signup endpoint takes a single `password`; the confirmation is
    // ours to check.
    if (password !== confirm) return setError(t("auth.errors.passwordsDontMatch"));
    mutation.mutate();
  }

  if (sentTo) {
    return (
      <AuthShell
        title={t("auth.signup.checkInbox")}
        subtitle={t("auth.signup.checkInboxBody", { email: sentTo })}
        footer={
          <Link to="/auth/login" className="font-medium text-navy hover:underline">
            {t("auth.backToSignIn")}
          </Link>
        }
      >
        <div className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
          {t("auth.signup.checkInbox")}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("auth.signup.title")}
      subtitle={t("auth.signup.subtitle")}
      footer={
        <>
          {t("auth.signup.haveAccount")}{" "}
          <Link to="/auth/login" className="font-medium text-navy hover:underline">
            {t("auth.signup.signInInstead")}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="signup-email">{t("auth.emailLabel")}</Label>
          <Input
            id="signup-email"
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
          <Label htmlFor="signup-password">{t("auth.passwordLabel")}</Label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="signup-confirm">{t("auth.confirmPasswordLabel")}</Label>
          <Input
            id="signup-confirm"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {error && <ErrorBanner message={error} />}

        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? t("common.loading") : t("auth.signUp")}
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
        onClick={() => void startProviderLogin("google", "/")}
      >
        <GoogleIcon />
        {t("auth.withGoogle")}
      </Button>
    </AuthShell>
  );
}

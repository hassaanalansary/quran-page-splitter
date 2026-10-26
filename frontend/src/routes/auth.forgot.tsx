import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BusyLabel } from "@/components/app/SatrLoader";
import {
  AUTH_LINK,
  AUTH_PRIMARY,
  AuthError as ErrorBanner,
  AuthField,
  AuthShell,
  AuthStateActions,
  AuthStateCard,
} from "@/components/app/auth/AuthShell";
import { AuthError, requestPasswordReset } from "@/lib/api";

export const Route = createFileRoute("/auth/forgot")({ component: ForgotPasswordPage });

function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => requestPasswordReset(email.trim()),
    onSuccess: () => setSentTo(email.trim()),
    onError: (e) => setError(e instanceof AuthError ? e.message : t("auth.errors.generic")),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  const backToSignIn = (
    <Link to="/auth/login" className={AUTH_LINK}>
      {t("auth.backToSignIn")}
    </Link>
  );

  // Deliberately the same message whether or not the address exists: allauth
  // is configured with ACCOUNT_PREVENT_ENUMERATION, and leaking "no such user"
  // here would undo that.
  if (sentTo) {
    return (
      <AuthShell>
        <AuthStateCard
          icon="mail"
          title={t("auth.reset.sent")}
          body={t("auth.reset.sentBody", { email: sentTo })}
        >
          <AuthStateActions>{backToSignIn}</AuthStateActions>
        </AuthStateCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthStateCard icon="key" title={t("auth.reset.title")} body={t("auth.reset.subtitle")}>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <AuthField
            id="forgot-email"
            label={t("auth.emailLabel")}
            compact
            type="email"
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          {error && <ErrorBanner message={error} />}
          <AuthStateActions>
            <button
              type="submit"
              disabled={mutation.isPending}
              className={`${AUTH_PRIMARY} cursor-pointer`}
            >
              {mutation.isPending ? (
                <BusyLabel>{t("common.loading")}</BusyLabel>
              ) : (
                t("auth.reset.submit")
              )}
            </button>
            {backToSignIn}
          </AuthStateActions>
        </form>
      </AuthStateCard>
    </AuthShell>
  );
}

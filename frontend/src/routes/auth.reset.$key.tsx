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
import { AuthError, resetPassword } from "@/lib/api";

/** Landing page for the link in allauth's password-reset email — the `{key}`
 * comes from HEADLESS_FRONTEND_URLS.account_reset_password_from_key. */
export const Route = createFileRoute("/auth/reset/$key")({ component: ResetPasswordPage });

function ResetPasswordPage() {
  const { t } = useTranslation();
  const { key } = Route.useParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [state, setState] = useState<"form" | "done" | "expired">("form");

  const mutation = useMutation({
    mutationFn: () => resetPassword(key, password),
    onSuccess: () => setState("done"),
    onError: (e) => {
      // allauth refuses a used or expired key on the `key` parameter; anything
      // else (a password it will not take) belongs to the form.
      if (e instanceof AuthError && (e.param === "key" || e.code === "invalid_password_reset")) {
        setState("expired");
        return;
      }
      setError(e instanceof AuthError ? e.message : t("auth.errors.generic"));
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMismatch(password !== confirm);
    if (password !== confirm) return;
    mutation.mutate();
  }

  const backToSignIn = (
    <Link to="/auth/login" className={AUTH_LINK}>
      {t("auth.backToSignIn")}
    </Link>
  );

  if (state === "done") {
    return (
      <AuthShell>
        <AuthStateCard
          icon="check"
          tone="done"
          title={t("auth.reset.done")}
          body={t("auth.reset.doneBody")}
        >
          <AuthStateActions>
            <Link to="/auth/login" className={AUTH_PRIMARY}>
              {t("auth.signIn")}
            </Link>
          </AuthStateActions>
        </AuthStateCard>
      </AuthShell>
    );
  }

  if (state === "expired") {
    return (
      <AuthShell>
        <AuthStateCard
          icon="alert"
          tone="stop"
          title={t("auth.reset.expiredTitle")}
          body={t("auth.reset.invalidKey")}
        >
          <AuthStateActions>
            <Link to="/auth/forgot" className={AUTH_PRIMARY}>
              {t("auth.reset.requestNew")}
            </Link>
            {backToSignIn}
          </AuthStateActions>
        </AuthStateCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthStateCard icon="key" title={t("auth.reset.newTitle")} body={t("auth.reset.newSubtitle")}>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <AuthField
            id="reset-password"
            label={t("auth.reset.newPasswordLabel")}
            compact
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
          <AuthField
            id="reset-confirm"
            label={t("auth.confirmPasswordLabel")}
            error={mismatch ? t("auth.errors.passwordsDontMatch") : null}
            compact
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {error && <ErrorBanner message={error} />}
          <AuthStateActions>
            <button
              type="submit"
              disabled={mutation.isPending}
              className={`${AUTH_PRIMARY} cursor-pointer`}
            >
              {mutation.isPending ? (
                <BusyLabel>{t("common.saving")}</BusyLabel>
              ) : (
                t("auth.reset.setPassword")
              )}
            </button>
            {backToSignIn}
          </AuthStateActions>
        </form>
      </AuthStateCard>
    </AuthShell>
  );
}

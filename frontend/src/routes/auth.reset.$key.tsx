import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthError as ErrorBanner, AuthShell } from "@/components/app/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => resetPassword(key, password),
    onSuccess: () => setDone(true),
    onError: (e) => setError(e instanceof AuthError ? e.message : t("auth.reset.invalidKey")),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError(t("auth.errors.passwordsDontMatch"));
    mutation.mutate();
  }

  const backToSignIn = (
    <Link to="/auth/login" className="font-medium text-navy hover:underline">
      {t("auth.backToSignIn")}
    </Link>
  );

  if (done) {
    return (
      <AuthShell
        title={t("auth.reset.done")}
        subtitle={t("auth.reset.doneBody")}
        footer={backToSignIn}
      >
        <div className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
          {t("auth.reset.done")}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("auth.reset.newTitle")}
      subtitle={t("auth.reset.newSubtitle")}
      footer={backToSignIn}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-password">{t("auth.passwordLabel")}</Label>
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-confirm">{t("auth.confirmPasswordLabel")}</Label>
          <Input
            id="reset-confirm"
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
          {mutation.isPending ? t("common.saving") : t("auth.reset.setPassword")}
        </Button>
      </form>
    </AuthShell>
  );
}

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthError as ErrorBanner, AuthShell } from "@/components/app/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <Link to="/auth/login" className="font-medium text-navy hover:underline">
      {t("auth.backToSignIn")}
    </Link>
  );

  // Deliberately the same message whether or not the address exists — allauth
  // is configured with ACCOUNT_PREVENT_ENUMERATION, and leaking "no such user"
  // here would undo that.
  if (sentTo) {
    return (
      <AuthShell
        title={t("auth.reset.sent")}
        subtitle={t("auth.reset.sentBody", { email: sentTo })}
        footer={backToSignIn}
      >
        <div className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
          {t("auth.reset.sent")}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("auth.reset.title")}
      subtitle={t("auth.reset.subtitle")}
      footer={backToSignIn}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="forgot-email">{t("auth.emailLabel")}</Label>
          <Input
            id="forgot-email"
            type="email"
            autoComplete="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>

        {error && <ErrorBanner message={error} />}

        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? t("common.loading") : t("auth.reset.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}

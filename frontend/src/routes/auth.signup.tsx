import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BusyLabel } from "@/components/app/SatrLoader";
import {
  AUTH_LINK,
  AuthError as ErrorBanner,
  AuthField,
  AuthHeading,
  AuthShell,
  AuthStateActions,
  AuthStateCard,
  AuthSubmit,
  GoogleStart,
} from "@/components/app/auth/AuthShell";
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
  // allauth names the field a refusal is about (`param`); that message goes under
  // its field, the rest in the banner.
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
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
      if (e instanceof AuthError && (e.param === "email" || e.param === "password")) {
        setFieldError({ field: e.param, message: e.message });
        return;
      }
      setError(e instanceof AuthError ? e.message : t("auth.errors.generic"));
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    // allauth's signup endpoint takes a single `password`; the confirmation is
    // ours to check.
    if (password !== confirm) {
      setFieldError({ field: "confirm", message: t("auth.errors.passwordsDontMatch") });
      return;
    }
    mutation.mutate();
  }

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  if (sentTo) {
    return (
      <AuthShell>
        <AuthStateCard
          icon="mail"
          title={t("auth.signup.checkInbox")}
          body={t("auth.signup.checkInboxBody", { email: sentTo })}
        >
          <AuthStateActions>
            <Link to="/auth/login" className={AUTH_LINK}>
              {t("auth.backToSignIn")}
            </Link>
          </AuthStateActions>
        </AuthStateCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell panel="signUp">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthHeading title={t("auth.signup.title")} subtitle={t("auth.signup.subtitle")} />
        <GoogleStart onClick={() => void startProviderLogin("google", "/")} />
        <AuthField
          id="signup-email"
          label={t("auth.emailLabel")}
          error={errorFor("email")}
          type="email"
          autoComplete="email"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <AuthField
          id="signup-password"
          label={t("auth.passwordLabel")}
          error={errorFor("password")}
          type="password"
          autoComplete="new-password"
          dir="ltr"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <AuthField
          id="signup-confirm"
          label={t("auth.confirmPasswordLabel")}
          error={errorFor("confirm")}
          type="password"
          autoComplete="new-password"
          dir="ltr"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />

        {error && <ErrorBanner message={error} />}

        <AuthSubmit disabled={mutation.isPending}>
          {mutation.isPending ? <BusyLabel>{t("common.loading")}</BusyLabel> : t("auth.signUp")}
        </AuthSubmit>
        <p className="m-0 mt-0.5 text-center text-[14px] text-ink-2">
          {t("auth.signup.haveAccount")}{" "}
          <Link to="/auth/login" className="font-semibold text-lapis-text hover:underline">
            {t("auth.signup.signInInstead")}
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

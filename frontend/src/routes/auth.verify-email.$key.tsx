import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AUTH_PRIMARY,
  AuthShell,
  AuthStateActions,
  AuthStateCard,
} from "@/components/app/auth/AuthShell";
import { verifyEmail } from "@/lib/api";

/** Landing page for the link in allauth's confirmation email — the `{key}`
 * comes from HEADLESS_FRONTEND_URLS.account_confirm_email. */
export const Route = createFileRoute("/auth/verify-email/$key")({ component: VerifyEmailPage });

function VerifyEmailPage() {
  const { t } = useTranslation();
  const { key } = Route.useParams();
  const [state, setState] = useState<"working" | "ok" | "failed">("working");
  // React 18's StrictMode mounts effects twice in dev; the key is single-use,
  // so a second POST would report a spurious failure.
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    verifyEmail(key).then(
      () => setState("ok"),
      () => setState("failed"),
    );
  }, [key]);

  if (state === "working") {
    return (
      <AuthShell>
        <AuthStateCard
          icon="working"
          title={t("auth.verify.verifying")}
          body={t("auth.verify.verifyingBody")}
        />
      </AuthShell>
    );
  }

  const ok = state === "ok";
  return (
    <AuthShell>
      <AuthStateCard
        icon={ok ? "check" : "alert"}
        tone={ok ? "done" : "stop"}
        title={ok ? t("auth.verify.success") : t("auth.verify.failed")}
        body={ok ? t("auth.verify.successBody") : t("auth.verify.failedBody")}
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

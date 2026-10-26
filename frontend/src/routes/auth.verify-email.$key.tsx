import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthShell } from "@/components/app/auth/AuthShell";
import { Button } from "@/components/ui/button";
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
      <AuthShell title={t("auth.verify.verifying")}>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunk">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-lapis" />
        </div>
      </AuthShell>
    );
  }

  const ok = state === "ok";
  return (
    <AuthShell
      title={ok ? t("auth.verify.success") : t("auth.verify.failed")}
      subtitle={ok ? t("auth.verify.successBody") : t("auth.verify.failedBody")}
    >
      <div
        className={
          ok
            ? "rounded-md border border-done/30 bg-done-wash px-3 py-2 text-sm text-done-text"
            : "rounded-md border border-stop/20 bg-stop-wash px-3 py-2 text-sm text-stop-text"
        }
      >
        {ok ? t("auth.verify.success") : t("auth.verify.failed")}
      </div>
      <Button asChild className="mt-5 w-full">
        <Link to="/auth/login">{t("auth.signIn")}</Link>
      </Button>
    </AuthShell>
  );
}

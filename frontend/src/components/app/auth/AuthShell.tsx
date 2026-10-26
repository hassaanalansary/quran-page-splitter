import { LanguageSwitcher } from "@/components/app/LanguageSwitcher";
import { SatrLockup } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";

/** Centered card used by every /auth/* page.
 *
 * These pages are reached from an email link as often as from inside the app,
 * so they carry their own chrome rather than relying on a workspace header.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="flex h-[52px] flex-shrink-0 items-center border-b border-rule bg-card px-6">
        <SatrLockup />
        <div className="ms-auto flex items-center gap-3">
          <ThemeButton />
          <LanguageSwitcher />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[380px]">
          <div className="rounded-xl border border-rule bg-card p-7 shadow-sm">
            <h1 className="font-display text-xl font-bold text-lapis-text">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-ink-2">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
          {footer && <div className="mt-4 text-center text-sm text-ink-2">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** Inline error banner, matching the style used across the app's forms. */
export function AuthError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-stop/20 bg-stop-wash px-3 py-2 text-sm text-stop-text">
      {message}
    </div>
  );
}

/** Google's mark. lucide has no brand icons, so this is inlined. */
export function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

import { Link } from "@tanstack/react-router";
import { Check, CircleAlert, KeyRound, Mail } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LanguageButton } from "@/components/app/LanguageSwitcher";
import { OrnamentStrip } from "@/components/app/Ornament";
import { SatrLoaderInline } from "@/components/app/SatrLoader";
import { SatrGlyph, SatrLockup, SatrSymbol, SatrWordmark } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";
import { cn } from "@/lib/utils";

/** The primary action of a state card, and its quieter way back. */
export const AUTH_PRIMARY =
  "inline-flex h-10 items-center rounded-control bg-lapis px-4 text-[14px] font-semibold text-on-lapis no-underline transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-60";
export const AUTH_LINK = "text-[13.5px] font-semibold text-lapis-text no-underline hover:underline";

/**
 * The layout every /auth/* page shares: the deep brand panel on the start side and
 * the form, or a state card in its place, on the other. These pages are reached
 * from an email link as often as from inside the app, so they carry their own
 * theme and language buttons rather than a workspace header. Sign-up gets the
 * panel that walks through the three phases; everything else the one that says
 * what the tool makes.
 */
export function AuthShell({
  panel = "signIn",
  children,
}: {
  panel?: "signIn" | "signUp";
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-wrap bg-paper">
      <aside className="relative flex flex-[1_1_520px] flex-col overflow-hidden bg-deep text-on-deep">
        <OrnamentStrip />
        <div
          className={`relative z-[1] flex flex-1 flex-col justify-center px-14 py-12 ${
            panel === "signIn" ? "gap-[34px]" : "gap-[30px]"
          }`}
        >
          {panel === "signIn" ? <SignInPanel /> : <SignUpPanel />}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-10 -end-[30px] text-on-deep/[0.04]"
        >
          <SatrGlyph className="h-[234px] w-[355px]" />
        </div>
      </aside>

      <main className="flex flex-[1_1_520px] flex-col bg-paper">
        <div className="flex justify-end gap-2 px-6 py-[18px]">
          <ThemeButton size={38} />
          <LanguageButton size={38} />
        </div>
        <div className="flex flex-1 items-center justify-center px-6 pb-14 pt-4">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
      </main>
    </div>
  );
}

function SignInPanel() {
  const { t } = useTranslation();
  const features = [
    [t("auth.panel.linesTitle"), t("auth.panel.linesBody")],
    [t("auth.panel.ayatTitle"), t("auth.panel.ayatBody")],
    [t("auth.panel.wordsTitle"), t("auth.panel.wordsBody")],
  ];

  return (
    <>
      <div className="flex items-center gap-[18px]">
        <SatrSymbol size={72} />
        <div role="img" aria-label={t("common.appName")} className="flex flex-col gap-1">
          <SatrWordmark height={31.68} />
          <span className="text-[14px] text-on-deep-2">
            <span lang="ar" className="font-quran text-[18px]">
              {t("common.appName", { lng: "ar" })}
            </span>{" "}
            · {t("auth.panel.meaning")}
          </span>
        </div>
      </div>
      <p className="m-0 max-w-[460px] font-display text-[26px] font-medium leading-[1.35]">
        {t("auth.panel.tagline")}
      </p>
      <div className="flex max-w-[460px] flex-col gap-4">
        {features.map(([title, body], i) => (
          <div key={title} className="flex items-start gap-3.5">
            <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-on-deep/[0.08] font-display text-[15px] font-semibold text-gold-on-deep">
              {i + 1}
            </span>
            <span className="flex flex-col gap-0.5">
              <strong className="text-[15px]">{title}</strong>
              <span className="text-[13.5px] leading-normal text-on-deep-2">{body}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function SignUpPanel() {
  const { t } = useTranslation();
  const phases = [
    [t("auth.panel.prepareTitle"), t("auth.panel.prepareBody")],
    [t("auth.panel.linesAyatTitle"), t("auth.panel.linesAyatBody")],
    [t("auth.panel.wordsPhaseTitle"), t("auth.panel.wordsPhaseBody")],
  ];

  return (
    <>
      <Link to="/" aria-label={t("topBar.home")} className="flex items-center self-start">
        <SatrLockup size={40} className="text-on-deep" />
      </Link>
      <h2 className="m-0 max-w-[470px] font-display text-[30px] font-medium leading-[1.3]">
        {t("auth.panel.phasesTitle")}
      </h2>
      <ol className="m-0 flex max-w-[470px] list-none flex-col p-0">
        {phases.map(([title, body], i) => (
          <li key={title} className="flex gap-4">
            <span className="flex flex-col items-center">
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-bold ${
                  i === 0 ? "bg-gold text-on-gold" : "border-2 border-gold text-gold-on-deep"
                }`}
              >
                {i + 1}
              </span>
              {i < phases.length - 1 && (
                <span className="min-h-[22px] w-0.5 flex-1 bg-on-deep/[0.18]" />
              )}
            </span>
            <span className={`flex flex-col gap-[3px] ${i < phases.length - 1 ? "pb-[18px]" : ""}`}>
              <strong className="text-[16px]">{title}</strong>
              <span className="text-[13.5px] leading-normal text-on-deep-2">{body}</span>
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** A form's title and the line under it. */
export function AuthHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 font-display text-[36px] font-semibold leading-[1.1]">{title}</h1>
      {subtitle && <p className="m-0 text-[15px] text-ink-2">{subtitle}</p>}
    </div>
  );
}

/** A labelled input: 2 px lapis on focus, --stop and a message on error. `aside`
 * sits at the end of the label row (Forgot your password?). */
export function AuthField({
  id,
  label,
  aside,
  error,
  compact = false,
  ...input
}: {
  id: string;
  label: string;
  aside?: ReactNode;
  error?: string | null;
  compact?: boolean;
} & ComponentProps<"input">) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={`flex items-baseline justify-between gap-3 font-semibold text-ink-2 ${
          compact ? "text-[12.5px]" : "text-[13px]"
        }`}
      >
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "w-full rounded-control border border-rule-2 bg-card text-ink outline-none transition-colors focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)] aria-[invalid=true]:border-stop aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--stop)]",
          compact ? "h-10 px-3 text-[14px]" : "h-[46px] px-3.5 text-[15px]",
        )}
        {...input}
      />
      {error && (
        <span id={errorId} className="flex items-center gap-1.5 text-[13px] text-stop-text">
          <CircleAlert className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  );
}

/** A form's own submit button: full width, 48 px. */
export function AuthSubmit({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="inline-flex h-12 w-full cursor-pointer items-center justify-center rounded-control bg-lapis text-[15px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-70"
    >
      {children}
    </button>
  );
}

/** "Continue with Google", then the "or" rule that leads into the form. */
export function GoogleStart({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className="flex h-[46px] w-full cursor-pointer items-center justify-center gap-2.5 rounded-control border border-rule-2 bg-card text-[14.5px] font-semibold text-ink transition-colors hover:bg-sheet"
      >
        <GoogleIcon />
        {t("auth.withGoogle")}
      </button>
      <div className="flex items-center gap-3 text-[13px] text-ink-4">
        <span className="h-px flex-1 bg-rule" />
        {t("auth.or")}
        <span className="h-px flex-1 bg-rule" />
      </div>
    </>
  );
}

const TONES = {
  info: "bg-lapis-wash text-lapis-text",
  done: "bg-done-wash text-done-text",
  stop: "bg-stop-wash text-stop-text",
} as const;

const ICONS = {
  mail: <Mail className="h-5 w-5" aria-hidden="true" />,
  key: <KeyRound className="h-5 w-5" aria-hidden="true" />,
  check: <Check className="h-5 w-5" strokeWidth={2.4} aria-hidden="true" />,
  alert: <CircleAlert className="h-5 w-5" aria-hidden="true" />,
  working: <SatrLoaderInline className="h-3 w-6" />,
} as const;

/** An account state (inbox, reset, verify…), in the form's place. `children` are
 * its field and its actions. */
export function AuthStateCard({
  icon,
  tone = "info",
  title,
  body,
  children,
}: {
  icon: keyof typeof ICONS;
  tone?: keyof typeof TONES;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-rule bg-card px-[26px] py-6">
      <span
        className={cn(
          "flex h-[42px] w-[42px] items-center justify-center rounded-full",
          TONES[tone],
        )}
      >
        {ICONS[icon]}
      </span>
      <h1 className="m-0 font-display text-[22px] font-semibold leading-[1.2]">{title}</h1>
      {body && <p className="m-0 text-[14px] leading-[1.55] text-ink-2">{body}</p>}
      {children}
    </div>
  );
}

/** A state card's actions row. */
export function AuthStateActions({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap items-center gap-3">{children}</div>;
}

/** Inline error banner, for what the server says is wrong with a form. */
export function AuthError({ message }: { message: string }) {
  return (
    <div className="rounded-control border border-stop/20 bg-stop-wash px-3 py-2 text-sm text-stop-text">
      {message}
    </div>
  );
}

/** Google's mark. lucide has no brand icons, so this is inlined; its colours are
 * Google's own, the same in both themes. */
export function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" className="h-[17px] w-[17px]" aria-hidden="true">
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

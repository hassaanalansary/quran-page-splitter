import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LanguageButton } from "@/components/app/LanguageSwitcher";
import { SatrLockup } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";
import { UserMenu } from "@/components/app/UserMenu";
import { useSession } from "@/lib/api";

const NAV_LINK =
  "inline-flex h-9 items-center rounded-control px-3.5 text-[14px] no-underline transition-colors";

/**
 * The top bar of the pages outside a mushaf: the library (My mushafs) and the
 * gallery. Signed out there is no library to go to, so the main nav is the gallery
 * alone and the account controls are Create account and Sign in.
 */
export function TopBar({ current }: { current: "mushafs" | "gallery" }) {
  const { t } = useTranslation();
  const { data: user } = useSession();

  const navItem = (here: boolean) =>
    `${NAV_LINK} ${here ? "bg-lapis-wash font-semibold text-lapis-text" : "font-medium text-ink-2 hover:bg-sunk hover:text-ink"}`;

  return (
    <header className="flex min-h-16 flex-shrink-0 flex-wrap items-center gap-x-[22px] gap-y-2.5 border-b border-rule bg-sheet px-7 py-2.5">
      <Link to="/" aria-label={t("topBar.home")} className="flex items-center">
        <SatrLockup size={30} />
      </Link>
      <nav aria-label={t("topBar.main")} className="flex gap-1">
        {user && (
          <Link
            to="/"
            aria-current={current === "mushafs" ? "page" : undefined}
            className={navItem(current === "mushafs")}
          >
            {t("gallery.myMushafs")}
          </Link>
        )}
        <Link
          to="/gallery"
          aria-current={current === "gallery" ? "page" : undefined}
          className={navItem(current === "gallery")}
        >
          {t("gallery.navLink")}
        </Link>
      </nav>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <ThemeButton size={38} />
        <LanguageButton size={38} />
        {user === null ? (
          <>
            <Link
              to="/auth/signup"
              className="inline-flex h-[38px] items-center px-3.5 text-[14px] font-semibold text-ink hover:text-lapis-text"
            >
              {t("auth.signUp")}
            </Link>
            <Link
              to="/auth/login"
              className="inline-flex h-[38px] items-center rounded-control bg-lapis px-4 text-[14px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90"
            >
              {t("auth.signIn")}
            </Link>
          </>
        ) : (
          <UserMenu size={38} />
        )}
      </div>
    </header>
  );
}

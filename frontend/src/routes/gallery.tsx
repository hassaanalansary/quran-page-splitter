import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AppLogo } from "@/components/app/AppLogo";
import { LanguageSwitcher } from "@/components/app/LanguageSwitcher";
import { UserMenu } from "@/components/app/UserMenu";
import { useSession } from "@/lib/api";

/** Layout for the public gallery: the listing and the read-only detail page.
 *
 * This file is not optional. With `gallery.index.tsx` present the route
 * generator emits a parent reference for it, and having no `gallery.tsx` leaves
 * that parent undefined — the tree then fails to build and every `/gallery`
 * URL falls through to Not Found. `routeTree.gen.ts` carries `@ts-nocheck`, so
 * `tsc` will not warn you about it either.
 *
 * Public — deliberately no `beforeLoad` guard. Anyone may browse and download;
 * only copying needs an account. This is also where anonymous visitors to `/`
 * are sent, so it doubles as the app's landing page.
 */
export const Route = createFileRoute("/gallery")({ component: GalleryLayout });

function GalleryLayout() {
  const { t } = useTranslation();
  const { data: user } = useSession();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-page">
      <header className="flex h-[52px] flex-shrink-0 items-center border-b border-border bg-white px-6">
        <Link to="/">
          <AppLogo />
        </Link>
        <div className="ms-auto flex items-center gap-3">
          {/* Signed out, `UserMenu` renders a "Sign in" button — the only way in
              from here, since the gallery is now the anonymous front door. */}
          {user && (
            <Link
              to="/"
              className="text-[12px] font-semibold text-text-secondary transition-colors hover:text-navy"
            >
              {t("gallery.myMushafs")}
            </Link>
          )}
          <LanguageSwitcher />
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

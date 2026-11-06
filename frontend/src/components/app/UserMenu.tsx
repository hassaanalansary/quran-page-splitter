import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LanguageMenuChoice } from "@/components/app/LanguageSwitcher";
import { ThemeMenuChoice } from "@/components/app/ThemeSwitcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout, useSession } from "@/lib/api";

/** The initials an avatar shows: the first letters of the first two words of
 * the display name ("Ibrahim Morad" → "IM"), else the address's first letter. */
function initialsOf(display: string, email: string): string {
  const words = display.trim().split(/\s+/).filter(Boolean);
  const letters = words.length ? words.slice(0, 2).map((word) => word[0]) : [email[0] ?? ""];
  return letters.join("").toUpperCase();
}

/** A menu row: 40 px, the board's 14 px text. */
const ITEM = "h-10 cursor-pointer rounded-none px-4 text-[14px] text-ink";

/** Avatar + account dropdown, in every top bar: the library and gallery's
 * (TopBar), the steps' (shell/WorkspaceTopBar) and the hub's (details/HubHeader). */
export function UserMenu({ size = 28 }: { size?: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: user, isPending } = useSession();

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      // Drop every cached response — it all belongs to the session just ended.
      queryClient.clear();
      await navigate({ to: "/auth/login" });
    },
  });

  if (isPending)
    return (
      <div className="animate-pulse rounded-full bg-sunk" style={{ width: size, height: size }} />
    );

  if (!user) {
    return (
      <Link
        to="/auth/login"
        className="inline-flex h-[34px] items-center rounded-control border border-rule-2 bg-card px-3 text-[13px] font-semibold text-ink no-underline transition-colors hover:bg-sheet"
      >
        {t("auth.signIn")}
      </Link>
    );
  }

  const label = user.display || user.email || "";
  const initials = initialsOf(user.display ?? "", user.email ?? "");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          style={{ width: size, height: size }}
          className={`flex flex-none items-center justify-center rounded-full bg-lapis font-semibold text-on-lapis outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-lapis ${
            size >= 36 ? "text-[13px]" : "text-xs"
          }`}
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 overflow-hidden rounded-panel border-0 p-0 shadow-[var(--shadow-card)]"
      >
        <DropdownMenuLabel className="flex items-center gap-3 border-b border-rule-soft px-4 py-3.5 font-normal">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-lapis text-[13px] font-semibold text-on-lapis">
            {initials}
          </span>
          <span className="flex min-w-0 flex-col">
            <span dir="auto" className="text-[12px] text-ink-3">
              {t("auth.menu.signedInAs")}
            </span>
            {/* Addresses are LTR even in the Arabic UI. */}
            <span dir="ltr" className="truncate text-start text-[13.5px] font-semibold text-ink">
              {user.email ?? label}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuItem asChild className={ITEM}>
          <Link to="/">{t("gallery.myMushafs")}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={ITEM}>
          <Link to="/gallery">{t("gallery.navLink")}</Link>
        </DropdownMenuItem>
        <div className="border-t border-rule-soft pt-1">
          <ThemeMenuChoice />
          <LanguageMenuChoice />
        </div>
        <DropdownMenuItem
          onSelect={() => signOut.mutate()}
          disabled={signOut.isPending}
          className={`${ITEM} h-[42px] border-t border-rule-soft text-stop-text focus:text-stop-text`}
        >
          {t("auth.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

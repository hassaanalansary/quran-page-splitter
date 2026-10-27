import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ThemeMenuChoice } from "@/components/app/ThemeSwitcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
      <Button asChild size="sm" variant="outline">
        <Link to="/auth/login">{t("auth.signIn")}</Link>
      </Button>
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
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div dir="auto" className="text-xs text-ink-3">
            {t("auth.menu.signedInAs")}
          </div>
          {/* Addresses are LTR even in the Arabic UI. */}
          <div dir="ltr" className="truncate text-sm font-medium text-lapis-text">
            {user.email ?? label}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeMenuChoice />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
          {t("auth.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

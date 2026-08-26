import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

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

/** Avatar + account dropdown. Rendered in both headers (the landing bar in
 * routes/index.tsx and the workspace bar in MushafHeader). */
export function UserMenu() {
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

  if (isPending) return <div className="h-7 w-7 animate-pulse rounded-full bg-bg-muted" />;

  if (!user) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/auth/login">{t("auth.signIn")}</Link>
      </Button>
    );
  }

  const label = user.display || user.email || "";
  const initial = label.slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-orange"
        >
          {initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div dir="auto" className="text-xs text-text-muted">
            {t("auth.menu.signedInAs")}
          </div>
          {/* Addresses are LTR even in the Arabic UI. */}
          <div dir="ltr" className="truncate text-sm font-medium text-navy">
            {user.email ?? label}
          </div>
        </DropdownMenuLabel>
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

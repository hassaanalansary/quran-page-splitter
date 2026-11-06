import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";

import { setThemePreference, THEME_PREFERENCES, useTheme, type ThemePreference } from "@/lib/theme";

/** The header's theme button: flips between light and dark. The account menu's
 * {@link ThemeMenuChoice} also offers System. 34 px in a step's top bar, 38 on the
 * library, gallery and sign-in pages. */
export function ThemeButton({ size = 34 }: { size?: number }) {
  const { t } = useTranslation();
  const { theme } = useTheme();

  return (
    <button
      type="button"
      onClick={() => setThemePreference(theme === "dark" ? "light" : "dark")}
      aria-label={t("theme.switch")}
      title={t("theme.switch")}
      style={{ width: size, height: size }}
      className="flex flex-none cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card text-ink transition-colors hover:bg-sheet focus-visible:outline-2 focus-visible:outline-lapis"
    >
      <svg
        viewBox="0 0 24 24"
        width={size >= 38 ? 17 : 16}
        height={size >= 38 ? 17 : 16}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
      </svg>
    </button>
  );
}

/** Light · Dark · System, as a segmented row inside the account menu. Choosing
 * keeps the menu open, so the change can be seen. */
export function ThemeMenuChoice() {
  const { t } = useTranslation();
  const { preference } = useTheme();

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <span className="text-[13.5px] text-ink">{t("theme.label")}</span>
      <DropdownMenuPrimitive.RadioGroup
        value={preference}
        onValueChange={(value) => setThemePreference(value as ThemePreference)}
        aria-label={t("theme.label")}
        className="inline-flex rounded-[7px] bg-sunk p-0.5"
      >
        {THEME_PREFERENCES.map((option) => (
          <DropdownMenuPrimitive.RadioItem
            key={option}
            value={option}
            onSelect={(event) => event.preventDefault()}
            className="flex h-7 cursor-pointer select-none items-center rounded-[5px] px-[9px] text-[12.5px] font-medium text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-lapis data-[state=checked]:bg-card data-[state=checked]:font-semibold data-[state=checked]:text-ink"
          >
            {t(`theme.${option}`)}
          </DropdownMenuPrimitive.RadioItem>
        ))}
      </DropdownMenuPrimitive.RadioGroup>
    </div>
  );
}

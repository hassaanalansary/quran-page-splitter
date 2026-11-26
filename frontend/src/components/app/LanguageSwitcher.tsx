import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";

import { baseLanguage, SUPPORTED_LANGUAGES } from "@/i18n/config";

/** English · العربية, as a segmented row inside the account menu, beside the
 * theme's. Choosing keeps the menu open. */
export function LanguageMenuChoice() {
  const { t, i18n } = useTranslation();
  const current = baseLanguage(i18n.language);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <span className="text-[13.5px] text-ink">{t("lang.label")}</span>
      <DropdownMenuPrimitive.RadioGroup
        value={current}
        onValueChange={(value) => void i18n.changeLanguage(value)}
        aria-label={t("lang.label")}
        className="inline-flex rounded-[7px] bg-sunk p-0.5"
      >
        {SUPPORTED_LANGUAGES.map((lng) => (
          <DropdownMenuPrimitive.RadioItem
            key={lng}
            value={lng}
            lang={lng}
            onSelect={(event) => event.preventDefault()}
            className="flex h-7 cursor-pointer select-none items-center rounded-[5px] px-2.5 text-[12.5px] font-medium text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-lapis data-[state=checked]:bg-card data-[state=checked]:font-semibold data-[state=checked]:text-ink"
          >
            {t(`lang.${lng}` as const)}
          </DropdownMenuPrimitive.RadioItem>
        ))}
      </DropdownMenuPrimitive.RadioGroup>
    </div>
  );
}

/** One button that switches to the other language, showing its short name (ع in
 * the English UI, EN in the Arabic one). */
export function LanguageButton({ size = 34 }: { size?: number }) {
  const { t, i18n } = useTranslation();
  const other = baseLanguage(i18n.language) === "ar" ? "en" : "ar";

  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(other)}
      aria-label={t(`lang.switchTo_${other}`)}
      title={t(`lang.switchTo_${other}`)}
      lang={other}
      style={{ width: size, height: size }}
      className={`flex flex-none cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card font-semibold text-ink transition-colors hover:bg-sheet focus-visible:outline-2 focus-visible:outline-lapis ${
        other === "ar" ? "font-ui-ar text-[15px]" : "text-[13px]"
      }`}
    >
      {t(`lang.short_${other}`)}
    </button>
  );
}

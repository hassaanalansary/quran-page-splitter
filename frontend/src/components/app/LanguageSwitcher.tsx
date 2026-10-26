import { useTranslation } from "react-i18next";

import { baseLanguage, SUPPORTED_LANGUAGES } from "@/i18n/config";

/** Segmented EN / ع control that switches the UI language (persisted). */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = baseLanguage(i18n.language);

  return (
    <div
      className="flex items-center gap-0.5 rounded-pill border border-rule p-0.5"
      role="group"
      aria-label={t("lang.label")}
    >
      {SUPPORTED_LANGUAGES.map((lng) => {
        const active = current === lng;
        return (
          <button
            key={lng}
            type="button"
            onClick={() => void i18n.changeLanguage(lng)}
            aria-pressed={active}
            title={t(`lang.${lng}` as const)}
            className={`min-w-[26px] rounded-pill px-2 py-0.5 text-[11px] font-semibold leading-none transition-colors ${
              active ? "bg-lapis text-on-lapis" : "text-ink-2 hover:bg-sheet"
            }`}
          >
            {t(`lang.short_${lng}` as const)}
          </button>
        );
      })}
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

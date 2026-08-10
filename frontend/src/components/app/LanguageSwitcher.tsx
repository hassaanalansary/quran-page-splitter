import { useTranslation } from "react-i18next";

import { baseLanguage, SUPPORTED_LANGUAGES } from "@/i18n/config";

/** Segmented EN / ع control that switches the UI language (persisted). */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = baseLanguage(i18n.language);

  return (
    <div
      className="flex items-center gap-0.5 rounded-pill border border-border p-0.5"
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
              active ? "bg-orange text-white" : "text-text-secondary hover:bg-bg-surface"
            }`}
          >
            {t(`lang.short_${lng}` as const)}
          </button>
        );
      })}
    </div>
  );
}

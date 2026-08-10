import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import { ar } from "./locales/ar";
import { en } from "./locales/en";

export const SUPPORTED_LANGUAGES = ["en", "ar"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Languages that render right-to-left. */
const RTL_LANGUAGES: readonly Language[] = ["ar"];

/** Bare language subtag (e.g. "ar-EG" → "ar"). */
export function baseLanguage(lng: string): string {
  return lng.split("-")[0];
}

export function isRtl(lng: string): boolean {
  return (RTL_LANGUAGES as readonly string[]).includes(baseLanguage(lng));
}

/** Mirror the active language onto <html lang/dir> for correct RTL layout. */
export function applyDocumentDirection(lng: string): void {
  const root = document.documentElement;
  root.lang = baseLanguage(lng);
  root.dir = isRtl(lng) ? "rtl" : "ltr";
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "htmlTag", "navigator"],
      lookupLocalStorage: "qps-language",
      caches: ["localStorage"],
    },
  });

applyDocumentDirection(i18n.language ?? "en");
i18n.on("languageChanged", applyDocumentDirection);

export default i18n;

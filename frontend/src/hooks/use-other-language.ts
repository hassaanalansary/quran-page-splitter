import { useTranslation } from "react-i18next";

import { baseLanguage } from "@/i18n/config";

/** The language the UI is not in, and a `t` that reads that language's catalog:
 * for the bilingual headings that set a title beside its other-language twin. */
export function useOtherLanguage() {
  const { i18n } = useTranslation();
  const lng = baseLanguage(i18n.language) === "ar" ? "en" : "ar";
  return { lng, t: i18n.getFixedT(lng) };
}

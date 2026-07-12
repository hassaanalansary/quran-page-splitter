import "i18next";

import type { en } from "./locales/en";

// Give t() compile-time key safety: keys are checked against the English
// catalog, so a typo or a key missing from the resources fails the build.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}

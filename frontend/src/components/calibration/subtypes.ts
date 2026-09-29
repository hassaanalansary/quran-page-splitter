/** Mark subtypes offered by default. Optional, never required, and free to grow:
 * the stored value is the key, so a new one is one entry here and one in each
 * catalog under `calibration.subtype`. */
export const SUBTYPES = [
  "fatha",
  "damma",
  "kasra",
  "sukun",
  "shadda",
  "tanween",
  "madda",
  "daggerAlif",
  "smallLetter",
  "ijamDot",
  "hamza",
  "wasla",
  "waqfSili",
  "waqfQili",
  "waqfJim",
  "waqfMim",
  "waqfLa",
  "other",
] as const;

export type Subtype = (typeof SUBTYPES)[number];

/** The types the digit keys give the selected marks: 1 to 9, then 0. The vowels in
 * the order they are taught, then the other marks a page is full of. */
export const HOTKEY_TYPES: readonly Subtype[] = [
  "fatha",
  "damma",
  "kasra",
  "sukun",
  "shadda",
  "madda",
  "wasla",
  "hamza",
  "daggerAlif",
  "ijamDot",
];

/** The key that types `subtype`, if one does. */
export const hotkeyOf = (subtype: string): string | null => {
  const index = (HOTKEY_TYPES as readonly string[]).indexOf(subtype);
  return index < 0 ? null : String((index + 1) % 10);
};

/** Each type as it sits on a letter, drawn on a tatweel: compact enough to label
 * every mark of a line under the line. */
export const SUBTYPE_MARKS: Record<Subtype, string> = {
  fatha: "ـَ",
  damma: "ـُ",
  kasra: "ـِ",
  sukun: "ـْ",
  shadda: "ـّ",
  tanween: "ـً",
  madda: "ـٓ",
  daggerAlif: "ـٰ",
  smallLetter: "ۥ",
  ijamDot: "•",
  hamza: "ء",
  wasla: "ٱ",
  waqfSili: "ۖ",
  waqfQili: "ۗ",
  waqfJim: "ۚ",
  waqfMim: "ۘ",
  waqfLa: "ۙ",
  other: "?",
};

export const SUBTYPE_GLYPHS: Record<Subtype, string> = {
  fatha: "◌َ",
  damma: "◌ُ",
  kasra: "◌ِ",
  sukun: "◌ْ",
  shadda: "◌ّ",
  tanween: "◌ً ◌ٌ ◌ٍ",
  madda: "◌ٓ",
  daggerAlif: "◌ٰ",
  smallLetter: "ۥ ۦ",
  ijamDot: "ب ت ث",
  hamza: "ء",
  wasla: "ٱ",
  waqfSili: "ۖ",
  waqfQili: "ۗ",
  waqfJim: "ۚ",
  waqfMim: "ۘ",
  waqfLa: "ۙ",
  other: "",
};

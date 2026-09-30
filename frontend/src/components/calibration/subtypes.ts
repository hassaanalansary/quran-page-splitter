import { subtypeParts } from "@/lib/calibration/model";

/** Mark subtypes offered by default. Optional, never required, and free to grow:
 * the stored value is the key, so a new one is one entry here and one in each
 * catalog under `calibration.subtype`.
 *
 * Marks printed touching as one blob — a hamza and its kasra under an alef — are
 * typed as a *pair*: their keys joined by "+" in `COMPOUND_ORDER` ("hamza+kasra"), the
 * way the server's `mark_check.compound` writes them. */
export const SUBTYPES = [
  "fatha",
  "damma",
  "kasra",
  "sukun",
  "roundZero",
  "rectZero",
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
  "waqfMuanaqa",
  "other",
] as const;

export type Subtype = (typeof SUBTYPES)[number];

/** The types the digit keys give the selected marks: 1 to 9, then 0. The vowels in
 * the order they are taught, then the other marks a page is full of. With Shift, a
 * digit adds its type to the mark's instead: two marks printed as one. */
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
  roundZero: "ـ۟",
  rectZero: "ـ۠",
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
  waqfMuanaqa: "ۛ",
  other: "?",
};

export const SUBTYPE_GLYPHS: Record<Subtype, string> = {
  fatha: "◌َ",
  damma: "◌ُ",
  kasra: "◌ِ",
  sukun: "◌ْ",
  roundZero: "◌۟",
  rectZero: "◌۠",
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
  waqfMuanaqa: "ۛ ۛ",
  other: "",
};

/** A stroke of a tanween, by the vowel it is typed as: shown as its tanween. */
export const TANWEEN_MARKS: Record<string, string> = {
  fatha: "ـً",
  damma: "ـٌ",
  kasra: "ـٍ",
  other: "ـٌ",
  tanween: "ـً",
};

/** A type as it sits on a letter; a pair's marks side by side. */
export const subtypeGlyph = (subtype: string): string =>
  subtypeParts(subtype)
    .map((part) => SUBTYPE_MARKS[part as Subtype] ?? "?")
    .join("") || "?";

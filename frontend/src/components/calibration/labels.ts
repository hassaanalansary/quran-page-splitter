// Server vocabularies to translation keys.
//
// Attention flags, gate reasons and the like arrive as the backend's own strings
// ("search-override", "insufficient_support"). `t()` is checked against the
// catalog's literal keys, so each is mapped here to a key that exists — returned
// as a literal type, so the caller's `t()` keeps checking it (the same trick as
// `issueKey` in the word-cuts route). A string the catalog has not heard of yet
// maps to null, and the caller shows it as it came rather than hiding it.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { subtypeParts } from "@/lib/calibration/model";

import { SUBTYPES, type Subtype } from "./subtypes";

const ATTENTION = {
  uncertain: "uncertain",
  "search-override": "searchOverride",
  "calibration-disagreement": "calibrationDisagreement",
  ambiguous: "ambiguous",
  "span-boundary": "spanBoundary",
  "constraint-conflict": "constraintConflict",
  "released-lock": "releasedLock",
} as const;

const REASONS = {
  no_examples: "noExamples",
  mixed_neighbors: "mixedNeighbors",
  insufficient_support: "insufficientSupport",
  insufficient_pages: "insufficientPages",
  too_far: "tooFar",
  missing_opposite: "missingOpposite",
  insufficient_margin: "insufficientMargin",
  insufficient_ratio: "insufficientRatio",
} as const;

const EXCEPTIONS = {
  mixed: "mixed",
  broken: "broken",
  fused: "fused",
  uncertain: "uncertain",
} as const;

const PROBLEMS = {
  flagged: "flagged",
  "paw-count": "pawCount",
  unresolved: "unresolved",
} as const;

function lookup<M extends Record<string, string>>(map: M, value: string): M[keyof M] | undefined {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value as keyof M] : undefined;
}

/** Why a blob asks for a look. */
export function attentionKey(flag: string) {
  const key = lookup(ATTENTION, flag);
  return key ? (`calibration.attention.${key}` as const) : null;
}

/** The longer explanation of an attention flag, for a tooltip. */
export function attentionHelpKey(flag: string) {
  const key = lookup(ATTENTION, flag);
  return key ? (`calibration.attentionHelp.${key}` as const) : null;
}

/** Why calibration made no proposal for a blob. */
export function reasonKey(reason: string) {
  const key = lookup(REASONS, reason);
  return key ? (`calibration.reason.${key}` as const) : null;
}

/** A blob's hand-set exception ("broken"), as the reviewer chose it. */
export function exceptionKey(exception: string) {
  const key = lookup(EXCEPTIONS, exception);
  return key ? (`calibration.exceptionKind.${key}` as const) : null;
}

/** What kind of thing a confirmation has to acknowledge. */
export function problemKey(kind: string) {
  const key = lookup(PROBLEMS, kind);
  return key ? (`calibration.problem.${key}` as const) : null;
}

/** A mark's optional subtype. */
export function subtypeKey(subtype: string) {
  return (SUBTYPES as readonly string[]).includes(subtype)
    ? (`calibration.subtype.${subtype as Subtype}` as const)
    : null;
}

/** A type's name in the reader's language: one mark's, or its parts' joined for marks
 * printed as one ("Hamza + Kasra"). A key the catalog does not know shows as it came. */
export function useTypeName(): (subtype: string) => string {
  const { t } = useTranslation();
  return useCallback(
    (subtype: string) =>
      subtypeParts(subtype)
        .map((part) => {
          const key = subtypeKey(part);
          return key ? t(key) : part;
        })
        .join(" + "),
    [t],
  );
}

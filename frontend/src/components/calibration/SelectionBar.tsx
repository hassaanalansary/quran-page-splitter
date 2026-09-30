import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  activeAttention,
  answeredBy,
  doubtOf,
  expectationKey,
  markCheckOf,
  shownType,
  typedByText,
  wordCount,
  type Doubts,
  type Expectations,
  type MarkChecks,
} from "@/lib/calibration/model";
import type {
  Allocation,
  BlobException,
  CalibrationBlob,
  CalibrationLine,
  TextRole,
  TypeEvidence,
} from "@/lib/calibration/types";

import { BlobCrop, OwnershipControls, RoleExamples } from "./BlobDetails";
import { attentionHelpKey, attentionKey, useTypeName } from "./labels";
import { HOTKEY_TYPES, SUBTYPES, SUBTYPE_GLYPHS, hotkeyOf, subtypeGlyph } from "./subtypes";

/** Screen px the bar always takes — it never grows with what it says, so the lines
 * above it never jump. Each pane scrolls on its own when it has more to say. */
const HEIGHT = 196;

const glyph = subtypeGlyph;

export type EvidenceTab = "type" | "role";

/**
 * Everything about the selection, in one place under the lines, at one height.
 *
 *     ┌ what it is ──────────────┬ its word ───────────┬ why ──────────────────┐
 *     │ picture · role · type    │ word · aya · PAWs   │ [Which type?][Body or │
 *     │ where · who decided      │ assign · share      │  mark?]  the nearest  │
 *     │ doubt · flags            │ unattach · flag     │  examples, as         │
 *     │ Body Mark 1…9 0 Accept   │ take back           │  pictures             │
 *     └──────────────────────────┴─────────────────────┴───────────────────────┘
 *
 * *Which type?* is the mark-type matcher: each type's own nearest typed marks. *Body
 * or mark?* is the role matcher: the confirmed blobs nearest this one, of either
 * role. The editor owns the draft, so it asks for the type evidence and passes it in.
 */
export function SelectionBar({
  mushafId,
  page,
  line,
  blobs,
  expectations,
  doubts,
  checks,
  evidence,
  tab,
  onTab,
  disabled,
  onRole,
  onSubtype,
  onAddPart,
  onAccept,
  onException,
  onAssign,
  onShare,
  onRelease,
  onUnassign,
}: {
  mushafId: string;
  page: number;
  line: CalibrationLine | null;
  blobs: CalibrationBlob[];
  expectations: Expectations;
  doubts: Doubts;
  /** Every word's marks against its text's. */
  checks: MarkChecks;
  /** The type evidence for the one selected mark; null when it is not asked for. */
  evidence: { data: TypeEvidence | null; loading: boolean } | null;
  tab: EvidenceTab;
  onTab: (tab: EvidenceTab) => void;
  disabled: boolean;
  onRole: (role: TextRole) => void;
  onSubtype: (subtype: string) => void;
  /** Add a type to the marks' own, or take it off: marks printed as one blob. */
  onAddPart: (part: string) => void;
  onAccept: () => void;
  onException: (exception: BlobException) => void;
  onAssign: (wordId: number, paws: number) => void;
  onShare: (shares: Allocation[]) => void;
  onRelease: () => void;
  onUnassign: () => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();

  if (!line || !blobs.length) {
    const keys: [string, string][] = [
      ["← →", t("calibration.bar.keyBlob")],
      ["↑ ↓", t("calibration.bar.keyLine")],
      ["Ctrl+← →", t("calibration.bar.keyWord")],
      ["Shift+← →", t("calibration.bar.keyAdd")],
      ["1–9, 0", t("calibration.bar.keyType")],
      ["Shift+1–9, 0", t("calibration.bar.keyAddPart")],
      ["A", t("calibration.bar.keyAccept")],
      ["B · M", t("calibration.bar.keyRole")],
      ["R", t("calibration.bar.keyReset")],
      ["N", t("calibration.bar.keyLook")],
      ["Esc", t("calibration.bar.keyClear")],
      ["Enter", t("calibration.bar.keyOpen")],
    ];
    return (
      <div
        className="flex flex-shrink-0 flex-col gap-2 overflow-y-auto border-t border-border bg-white px-3 py-2.5"
        style={{ height: HEIGHT }}
      >
        <p className="text-[12px] text-text-secondary">{t("calibration.bar.empty")}</p>
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-4 gap-y-1">
          {keys.map(([key, what]) => (
            <div key={key} className="flex items-baseline gap-2 text-[11.5px]">
              <dt className="w-[76px] flex-none">
                <kbd className="rounded-sm border border-border-strong px-1 font-sans text-[10.5px] text-text-primary">
                  {key}
                </kbd>
              </dt>
              <dd className="text-text-muted">{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const single = blobs.length === 1 ? blobs[0] : null;
  const marks = blobs.filter((blob) => blob.role === "mark");
  const bodies = blobs.filter((blob) => blob.role === "body");
  const shown = marks.map((blob) => shownType(blob, line.snapshot_id, expectations));
  const expected = shown.filter((type) => type && !type.typed).length;
  const typedAs = (subtype: string) =>
    marks.length > 0 && marks.every((_, i) => shown[i]?.typed && shown[i]?.subtype === subtype);
  const expectedAs = (subtype: string) =>
    shown.some((type) => type && !type.typed && type.subtype === subtype);
  const doubt = single ? doubtOf(single, line.snapshot_id, doubts) : null;
  /** Where the one selected mark's expected type comes from. */
  const guess =
    single && single.role === "mark"
      ? expectations.get(expectationKey(line.snapshot_id, single.id))
      : undefined;
  const flags = [...new Set(blobs.flatMap(activeAttention))];
  const owners = [...new Set(blobs.flatMap((blob) => blob.allocations.map((a) => a.word_id)))];
  const others = SUBTYPES.filter((value) => !hotkeyOf(value));
  const otherValue =
    marks.length > 0 && others.some((value) => typedAs(value)) ? marks[0].subtype : "";
  const oneMark = single?.role === "mark" ? single : null;
  const oneText = single && (single.role === "body" || single.role === "mark") ? single : null;
  // A body has no type to explain: its evidence is the role's.
  const showing: EvidenceTab = oneMark ? tab : "role";

  // ── what it is ─────────────────────────────────────────────────────────────
  let headline: string;
  let status: { text: string; tone: "typed" | "expected" | "none" } | null = null;
  if (single) {
    const type = shown[0] ?? null;
    headline = t(`calibration.role.${single.role}`);
    if (single.role === "mark" && type) {
      headline += ` · ${glyph(type.subtype)} ${typeName(type.subtype)}`;
      status = type.typed
        ? {
            text: t(typedByText(single) ? "calibration.bar.typedByText" : "calibration.bar.typed"),
            tone: "typed",
          }
        : {
            text: t(type.sure ? "calibration.bar.expectedSure" : "calibration.bar.expectedLikely"),
            tone: "expected",
          };
    } else if (single.role === "mark") {
      status = { text: t("calibration.bar.noType"), tone: "none" };
    }
  } else {
    headline = t("calibration.bar.many", { count: blobs.length, line: line.line_number });
  }

  const breakdown = new Map<string, { typed: number; expected: number }>();
  let untyped = 0;
  for (const type of shown) {
    if (!type) {
      untyped += 1;
      continue;
    }
    const entry = breakdown.get(type.subtype) ?? { typed: 0, expected: 0 };
    if (type.typed) entry.typed += 1;
    else entry.expected += 1;
    breakdown.set(type.subtype, entry);
  }

  return (
    <div
      className="flex-shrink-0 overflow-x-auto border-t border-border bg-white"
      style={{ height: HEIGHT }}
    >
      <div className="grid h-full min-w-[900px] grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* ── what it is ── */}
        <section className="flex min-h-0 flex-col gap-1.5 overflow-y-auto border-e border-border px-3 py-2">
          <div className="flex items-start gap-2.5">
            {single && line.image_url && (
              <BlobCrop
                url={line.image_url}
                x={single.x - line.bbox.x}
                y={single.y - line.bbox.y}
                w={single.w}
                h={single.h}
                box={56}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span dir="auto" className="text-[14px] font-semibold text-text-primary">
                  {headline}
                </span>
                {status && (
                  <span
                    className={`rounded-sm px-1.5 py-px text-[10.5px] ${
                      status.tone === "typed"
                        ? "bg-navy text-white"
                        : status.tone === "expected"
                          ? "border border-dashed border-border-strong text-text-secondary"
                          : "bg-bg-surface text-text-muted"
                    }`}
                  >
                    {status.text}
                  </span>
                )}
              </div>
              <span className="text-[10.5px] tabular-nums text-text-muted">
                {single
                  ? `${t("calibration.bar.where", {
                      line: line.line_number,
                      id: single.id,
                      w: single.w,
                      h: single.h,
                    })} · ${t(`calibration.source.${single.decision_source}`)}`
                  : t("calibration.bar.counts", { marks: marks.length, bodies: bodies.length })}
              </span>
              {!single && (breakdown.size > 0 || untyped > 0) && (
                <span className="flex flex-wrap gap-x-2.5 text-[11px] text-text-secondary">
                  {[...breakdown.entries()].map(([subtype, count]) => (
                    <span key={subtype}>
                      <span dir="rtl">{glyph(subtype)}</span> {typeName(subtype)} ×
                      {count.typed + count.expected}
                      {count.expected > 0 && (
                        <span className="text-text-muted">
                          {" "}
                          {t("calibration.bar.expectedCount", { count: count.expected })}
                        </span>
                      )}
                    </span>
                  ))}
                  {untyped > 0 && (
                    <span className="text-text-muted">
                      {t("calibration.bar.untypedCount", { count: untyped })}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {status?.tone === "expected" && guess?.source && (
            <span className="text-[10.5px] leading-snug text-text-muted">
              {t(
                guess.source === "text"
                  ? "calibration.bar.fromText"
                  : guess.source === "image"
                    ? "calibration.bar.fromImage"
                    : "calibration.bar.fromExamples",
              )}
            </span>
          )}
          {guess?.text && (
            <div className="rounded-sm bg-warning-bg px-2 py-1 text-[11px] leading-snug text-[#8a4b0d]">
              {t("calibration.bar.textConflict", {
                type: `${glyph(guess.text)} ${typeName(guess.text)}`,
              })}
            </div>
          )}
          {doubt && (
            <div className="rounded-sm bg-warning-bg px-2 py-1 text-[11px] leading-snug text-[#8a4b0d]">
              {t(
                doubt.source === "text"
                  ? "calibration.bar.doubtText"
                  : doubt.sure
                    ? "calibration.bar.doubtSure"
                    : "calibration.bar.doubt",
                {
                  typed: typeName(doubt.typed),
                  type: `${glyph(doubt.subtype)} ${typeName(doubt.subtype)}`,
                },
              )}
            </div>
          )}
          {single && answeredBy(single) && (
            <span className="text-[10.5px] leading-snug text-text-muted">
              {t(
                answeredBy(single) === "text"
                  ? "calibration.bar.answeredText"
                  : "calibration.bar.answeredExamples",
              )}
            </span>
          )}
          {flags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {flags.map((flag) => {
                const label = attentionKey(flag);
                const help = attentionHelpKey(flag);
                return (
                  <span
                    key={flag}
                    className="rounded-sm bg-warning-bg px-1.5 py-0.5 text-[10.5px] text-[#8a4b0d]"
                    title={help ? t(help) : undefined}
                  >
                    {label ? t(label) : flag}
                  </span>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1">
            {(["body", "mark"] as const).map((choice) => (
              <Button
                key={choice}
                type="button"
                variant={blobs.every((blob) => blob.role === choice) ? "default" : "outline"}
                className="h-7 px-2 text-[12px]"
                disabled={disabled}
                onClick={() => onRole(choice)}
                title={t(`calibration.key.${choice}`)}
              >
                {t(`calibration.role.${choice}`)}
                <Key>{choice === "body" ? "B" : "M"}</Key>
              </Button>
            ))}
            {expected > 0 && (
              <Button
                type="button"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={disabled}
                onClick={onAccept}
                title={t("calibration.key.accept")}
              >
                {single && shown[0]
                  ? t("calibration.bar.acceptOne", {
                      type: `${glyph(shown[0].subtype)} ${typeName(shown[0].subtype)}`,
                    })
                  : t("calibration.bar.acceptMany", { count: expected })}
                <Key>A</Key>
              </Button>
            )}
          </div>
          {marks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {HOTKEY_TYPES.map((value) => {
                const key = hotkeyOf(value);
                const typed = typedAs(value);
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={disabled}
                    onClick={() => onSubtype(value)}
                    title={t("calibration.bar.typeKey", { type: typeName(value), key })}
                    aria-label={typeName(value)}
                    aria-pressed={typed}
                    className={`relative flex h-7 min-w-[30px] cursor-pointer items-center justify-center rounded-sm border px-1 text-[15px] leading-none transition-colors disabled:cursor-default disabled:opacity-40 ${
                      typed
                        ? "border-navy bg-navy text-white"
                        : expectedAs(value)
                          ? "border-dashed border-orange bg-orange-tint text-text-primary"
                          : "border-border-strong bg-white text-text-primary hover:bg-bg-surface"
                    }`}
                  >
                    <span dir="rtl">{glyph(value)}</span>
                    <span className="absolute end-0.5 top-0 text-[8.5px] font-semibold opacity-60">
                      {key}
                    </span>
                  </button>
                );
              })}
              <select
                aria-label={t("calibration.bar.moreTypes")}
                title={t("calibration.bar.moreTypes")}
                className="h-7 w-[92px] cursor-pointer rounded-sm border border-border-strong bg-white px-1 text-[11.5px] disabled:cursor-default disabled:opacity-40"
                disabled={disabled}
                value={otherValue}
                onChange={(event) =>
                  onSubtype(event.target.value === "__none" ? "" : event.target.value)
                }
              >
                <option value="" disabled>
                  {t("calibration.bar.moreTypes")}
                </option>
                {others.map((value) => (
                  <option key={value} value={value}>
                    {SUBTYPE_GLYPHS[value]} · {typeName(value)}
                  </option>
                ))}
                <option value="__none">{t("calibration.subtypeNone")}</option>
              </select>
              <select
                aria-label={t("calibration.bar.addPart")}
                title={t("calibration.bar.addPartHelp")}
                className="h-7 w-[92px] cursor-pointer rounded-sm border border-border-strong bg-white px-1 text-[11.5px] disabled:cursor-default disabled:opacity-40"
                disabled={disabled}
                value=""
                onChange={(event) => {
                  if (event.target.value) onAddPart(event.target.value);
                }}
              >
                <option value="" disabled>
                  {t("calibration.bar.addPart")}
                </option>
                {SUBTYPES.filter((value) => value !== "other").map((value) => (
                  <option key={value} value={value}>
                    {SUBTYPE_GLYPHS[value]} · {typeName(value)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        {/* ── its word ── */}
        <section className="flex min-h-0 flex-col gap-1.5 overflow-y-auto border-e border-border px-3 py-2">
          <PaneTitle>{t("calibration.belongsTo")}</PaneTitle>
          <div className="flex flex-col gap-0.5">
            {owners.length === 0 ? (
              <span className="text-[12px] text-text-muted">{t("calibration.bar.noWord")}</span>
            ) : (
              owners.map((id) => {
                const word = line.words.find((candidate) => candidate.word_id === id);
                const count = word ? wordCount(line, word) : null;
                const check = markCheckOf(line.snapshot_id, id, checks);
                const unfit = check
                  ? [
                      check.missing.length
                        ? t("calibration.bar.marksMissing", {
                            types: check.missing
                              .map((kind) => `${glyph(kind)} ${typeName(kind)}`)
                              .join(", "),
                          })
                        : "",
                      check.extra.length
                        ? t("calibration.bar.marksExtra", { count: check.extra.length })
                        : "",
                      check.disagree.length
                        ? t("calibration.bar.marksDisagree", { count: check.disagree.length })
                        : "",
                    ].filter(Boolean)
                  : [];
                return (
                  <div key={id} className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <span dir="rtl" className="text-[15px] leading-tight text-text-primary">
                        {word?.text ?? `#${id}`}
                      </span>
                      {word && <span className="text-[10.5px] text-text-muted">{word.aya}</span>}
                      {count && (
                        <span
                          className={`rounded-sm px-1 text-[10px] font-semibold tabular-nums ${
                            count.ok ? "text-orange" : "bg-warning text-white"
                          }`}
                          title={t("calibration.countHelp")}
                        >
                          {count.got}/{count.want}
                        </span>
                      )}
                    </span>
                    {check && (
                      <span
                        className={`text-[10.5px] leading-snug ${
                          check.ok ? "text-text-muted" : "text-[#8a4b0d]"
                        }`}
                        title={t("calibration.bar.marksHelp")}
                      >
                        {check.ok ? t("calibration.bar.marksFit") : unfit.join(" · ")}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <OwnershipControls
            key={`${line.snapshot_id}:${blobs.map((blob) => blob.id).join(",")}`}
            line={line}
            blobs={blobs}
            disabled={disabled}
            onException={onException}
            onAssign={onAssign}
            onShare={onShare}
            onRelease={onRelease}
            onUnassign={onUnassign}
          />
        </section>

        {/* ── why ── */}
        <section className="flex min-h-0 flex-col">
          <div role="tablist" className="flex flex-none border-b border-border">
            {(["type", "role"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={showing === value}
                disabled={value === "type" && !oneMark}
                onClick={() => onTab(value)}
                title={t(
                  value === "type" ? "calibration.bar.tabTypeHelp" : "calibration.bar.tabRoleHelp",
                )}
                className={`flex-1 cursor-pointer px-2 py-1.5 text-[11.5px] font-medium transition-colors disabled:cursor-default disabled:opacity-40 ${
                  showing === value
                    ? "border-b-2 border-orange text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {t(value === "type" ? "calibration.bar.tabType" : "calibration.bar.tabRole")}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {showing === "type" && oneMark ? (
              <TypeEvidencePanel
                mushafId={mushafId}
                evidence={evidence}
                typeName={typeName}
                typed={!!shown[0]?.typed}
              />
            ) : showing === "role" && oneText ? (
              <RoleExamples mushafId={mushafId} page={page} line={line} blob={oneText} />
            ) : (
              <p className="text-[11px] text-text-muted">
                {t(
                  oneMark || !marks.length ? "calibration.bar.oneBlob" : "calibration.bar.oneMark",
                )}
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Which type? Each type near the mark, its score, and its own nearest typed marks. */
function TypeEvidencePanel({
  mushafId,
  evidence,
  typeName,
  typed,
}: {
  mushafId: string;
  evidence: { data: TypeEvidence | null; loading: boolean } | null;
  typeName: (subtype: string) => string;
  typed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10.5px] leading-snug text-text-muted">
        {t(typed ? "calibration.bar.typeHintTyped" : "calibration.bar.typeHintUntyped")}
      </p>
      {!evidence || (evidence.loading && !evidence.data) ? (
        <span className="text-[11px] text-text-muted">{t("calibration.bar.loadingEvidence")}</span>
      ) : !evidence.data?.candidates.length ? (
        <span className="text-[11px] text-text-muted">{t("calibration.bar.noEvidence")}</span>
      ) : (
        evidence.data.candidates.map((candidate, index) => (
          <div key={candidate.subtype} className="flex items-center gap-1.5">
            <span
              className={`w-[96px] flex-none truncate text-[11.5px] ${
                index === 0 ? "font-semibold text-text-primary" : "text-text-secondary"
              }`}
              title={typeName(candidate.subtype)}
            >
              <span dir="rtl">{glyph(candidate.subtype)}</span> {typeName(candidate.subtype)}
            </span>
            <span
              className="w-8 flex-none text-[10px] tabular-nums text-text-muted"
              title={t("calibration.bar.distanceHelp")}
            >
              {candidate.distance.toFixed(2)}
            </span>
            {candidate.examples.map((example) => (
              <Link
                key={`${example.snapshot_id}:${example.blob_id}`}
                to="/mushafs/$mushafId/word-cuts"
                params={{ mushafId }}
                search={{ page: example.page_number, mode: "calibrate" }}
                title={t("calibration.bar.exampleTitle", {
                  page: example.page_number,
                  line: example.line_number,
                  distance: example.distance.toFixed(3),
                  copies: example.copies,
                })}
                className="rounded-sm outline-offset-1 hover:outline hover:outline-2 hover:outline-orange"
              >
                <BlobCrop url={example.image_url} {...example.crop} box={32} />
              </Link>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function PaneTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
      {children}
    </div>
  );
}

/** A key's letter, set small after a button's label. */
function Key({ children }: { children: string }) {
  return (
    <kbd className="ms-1.5 rounded-sm border border-current/30 px-1 font-sans text-[9.5px] leading-[14px] opacity-70">
      {children}
    </kbd>
  );
}

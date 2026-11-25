import { BookOpen, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  activeAttention,
  answeredBy,
  canBeCalledText,
  doubtOf,
  expectationKey,
  noiseFor,
  shownType,
  typedByText,
  type ContentsChip,
  type Doubts,
  type Expectations,
  type MarkChecks,
  type NoiseSuspects,
} from "@/lib/calibration/model";
import type {
  Allocation,
  BlobException,
  CalibrationBlob,
  CalibrationLine,
  LibraryCompare,
  TextRole,
} from "@/lib/calibration/types";
import { cn } from "@/lib/utils";

import { BelongsTo } from "./BelongsTo";
import { BlobCrop, type KnifeControls } from "./BlobDetails";
import { ChipRow, ContentsChips } from "./ContentsChips";
import { ROLE_RGB } from "./colors";
import { attentionHelpKey, attentionKey, useTypeName } from "./labels";
import { HOTKEY_TYPES, SUBTYPES, SUBTYPE_GLYPHS, hotkeyOf, subtypeGlyph } from "./subtypes";

/** Screen px the bar always takes — it never grows with what it says, so the lines
 * above it never jump. Each pane scrolls on its own when it has more to say. */
const HEIGHT = 262;

const glyph = subtypeGlyph;

/** A compact select at the end of a chip row. */
const ROW_SELECT =
  "h-7 min-w-0 max-w-[170px] cursor-pointer rounded-control border border-rule-2 bg-card px-1.5 text-[12.5px] text-ink-2 outline-none hover:border-lapis focus:border-lapis disabled:cursor-default disabled:opacity-50";
/** A two-state chip: a flag, the library's door. */
const TOGGLE =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-[12.5px] transition-colors disabled:cursor-default disabled:opacity-50";
const TOGGLE_ON = "border-lapis bg-lapis-wash font-semibold text-lapis-text";
const TOGGLE_OFF = "border-rule-2 bg-card text-ink-2 hover:border-lapis hover:text-ink";

/** A note the bar has for the selection: a warning, or a quiet word on where a type
 * comes from. */
type Note = { text: string; warn: boolean };

/**
 * Everything about the selection, in one place under the lines, at one height —
 * every control in sight, nothing behind a scroll.
 *
 *     ┌ picture · role · type · status · flags · where, who decided · [Ask the library] ┐
 *     ├ what it is, what it holds ─────────────┬ belongs to ──────────┬ library says ──┤
 *     │ Body|Mark  Erase       Broken Unsure   │ word · aya · 3/3 · ✓ │ (only while    │
 *     │ Letters   ٱ [لر] حمن                    │ Move to word ▾       │  open: asked   │
 *     │ Touching  [shadda] fatha  + other ▾     │ Share with ‹word›    │  only then)    │
 *     │ a note, when there is one               │ Take back decisions  │                │
 *     ├ ← → blob · ↑ ↓ line · Ctrl ← → word · B M · 1–9 0 · A · N · Ctrl S ─────────────┤
 *
 * For a mark the chips are its word's text's types — typed solid, expected dashed,
 * accepted with a click or A — with any other type and a pair behind two selects.
 * *Library says* is the fingerprint library's answer for the one selected blob; it is
 * asked only while its panel is open, since each ask sends the whole draft.
 */
export function SelectionBar({
  line,
  blobs,
  expectations,
  doubts,
  checks,
  noise,
  library,
  libraryOpen,
  onLibraryOpen,
  onShowInLibrary,
  disabled,
  onRole,
  onSubtype,
  onAddPart,
  onAccept,
  onException,
  onContentsChip,
  onErase,
  onAssign,
  onShare,
  onRelease,
  onUnassign,
  onGiveBack,
  knife,
}: {
  line: CalibrationLine | null;
  blobs: CalibrationBlob[];
  expectations: Expectations;
  doubts: Doubts;
  /** Every word's marks against its text's. */
  checks: MarkChecks;
  /** Marks that may be noise the line's cutting left. */
  noise: NoiseSuspects;
  /** What the library answers for the one selected blob; null when it is not asked. */
  library: { data: LibraryCompare | null; loading: boolean } | null;
  /** The library panel is open: the editor asks the library only then. */
  libraryOpen: boolean;
  onLibraryOpen: (open: boolean) => void;
  /** Open the Library mode on this blob. */
  onShowInLibrary: () => void;
  disabled: boolean;
  onRole: (role: TextRole) => void;
  onSubtype: (subtype: string) => void;
  /** Add a type to the marks' own, or take it off: marks printed as one blob. */
  onAddPart: (part: string) => void;
  onAccept: () => void;
  onException: (exception: BlobException) => void;
  /** A labeling bar chip ticked or unticked on the one selected text blob. */
  onContentsChip: (chip: ContentsChip) => void;
  /** Erase the selected ink, or restore it. */
  onErase: (erased: boolean) => void;
  onAssign: (wordId: number, paws: number) => void;
  onShare: (shares: Allocation[]) => void;
  onRelease: () => void;
  onUnassign: () => void;
  /** Give the selected structure a person called text back to its symbol or ornament. */
  onGiveBack: () => void;
  /** The knife on the one selected shared body. */
  knife: KnifeControls;
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
      ["Del", t("calibration.bar.keyErase")],
      ["N", t("calibration.bar.keyLook")],
      ["Esc", t("calibration.bar.keyClear")],
      ["Enter", t("calibration.bar.keyOpen")],
      ["Ctrl+S", t("calibration.bar.keySave")],
    ];
    return (
      <Frame>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <p className="m-0 text-[13px] text-ink-2">{t("calibration.bar.empty")}</p>
          <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-5 gap-y-1.5">
            {keys.map(([key, what]) => (
              <div key={key} className="flex items-baseline gap-2 text-[12px]">
                <dt className="w-[84px] flex-none">
                  <Kbd>{key}</Kbd>
                </dt>
                <dd className="m-0 text-ink-3">{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Frame>
    );
  }

  const single = blobs.length === 1 ? blobs[0] : null;
  const marks = blobs.filter((blob) => blob.role === "mark");
  const bodies = blobs.filter((blob) => blob.role === "body");
  const shown = marks.map((blob) => shownType(blob, line.snapshot_id, expectations));
  const expected = shown.filter((type) => type && !type.typed).length;
  const typedAs = (subtype: string) =>
    marks.length > 0 && marks.every((_, i) => shown[i]?.typed && shown[i]?.subtype === subtype);
  const doubt = single ? doubtOf(single, line.snapshot_id, doubts) : null;
  /** Where the one selected mark's expected type comes from. */
  const guess =
    single && single.role === "mark"
      ? expectations.get(expectationKey(line.snapshot_id, single.id))
      : undefined;
  const flags = [...new Set(blobs.flatMap(activeAttention))];
  // Every type in one list, the hotkeyed ones first with their key.
  const choices = [...HOTKEY_TYPES, ...SUBTYPES.filter((value) => !hotkeyOf(value))];
  const typeValue =
    marks.length > 0 && choices.some((value) => typedAs(value)) ? marks[0].subtype : "";
  const oneText = single && (single.role === "body" || single.role === "mark") ? single : null;
  const texts = blobs.filter((blob) => blob.role === "body" || blob.role === "mark");
  const live = texts.filter((blob) => !blob.erased);
  /** What measurement took every selected blob for, when that is one kind of structure
   * a person may call text: the role the last button gives them back. */
  const structure =
    blobs.every(canBeCalledText) &&
    blobs.every((blob) => blob.initial_role === blobs[0].initial_role)
      ? (blobs[0].initial_role as "symbol" | "ornament")
      : null;
  /** Selected structure still out of the reading: a sign, or a piece of an ornament. */
  const stillSymbols = blobs.some((blob) => blob.role === "symbol");
  const stillPieces = blobs.some((blob) => blob.role === "ornament" && canBeCalledText(blob));
  /** Every text blob selected is erased: the button restores them. */
  const erased = texts.length > 0 && texts.every((blob) => blob.erased);
  const suspicion = single ? noiseFor(single, line.snapshot_id, noise) : null;
  const libraryShown = libraryOpen && texts.length > 0;

  // ── what is selected ──────────────────────────────────────────────────────
  let headline: { name: string; glyph?: string } | null = null;
  let status: { text: string; tone: "typed" | "expected" | "none" } | null = null;
  if (single) {
    const type = shown[0] ?? null;
    if (single.erased) {
      status = { text: t("calibration.bar.erased"), tone: "none" };
    } else if (single.role === "mark" && type) {
      headline = { name: typeName(type.subtype), glyph: glyph(type.subtype) };
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
    headline = { name: t("calibration.bar.many", { count: blobs.length, line: line.line_number }) };
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

  // ── what the bar has to say: warnings first ────────────────────────────────
  const notes: Note[] = [];
  if (suspicion)
    notes.push({
      text: `${t(`calibration.noise.${suspicion.kind}Help`)}${
        suspicion.edge ? ` ${t("calibration.noise.edgeHelp")}` : ""
      }`,
      warn: true,
    });
  if (guess?.text)
    notes.push({
      text: t("calibration.bar.textConflict", {
        type: `${glyph(guess.text)} ${typeName(guess.text)}`,
      }),
      warn: true,
    });
  if (doubt)
    notes.push({
      text: t(
        doubt.source === "text"
          ? "calibration.bar.doubtText"
          : doubt.source === "sign"
            ? "calibration.bar.doubtSign"
            : doubt.sure
              ? "calibration.bar.doubtSure"
              : "calibration.bar.doubt",
        {
          typed: typeName(doubt.typed),
          type: `${glyph(doubt.subtype)} ${typeName(doubt.subtype)}`,
        },
      ),
      warn: true,
    });
  if (single?.erased) notes.push({ text: t("calibration.bar.erasedHelp"), warn: false });
  if (stillSymbols) notes.push({ text: t("calibration.bar.symbolHelp"), warn: false });
  if (stillPieces) notes.push({ text: t("calibration.bar.ornamentPieceHelp"), warn: false });
  if (status?.tone === "expected" && guess?.source)
    notes.push({
      text: t(
        guess.source === "text"
          ? "calibration.bar.fromText"
          : guess.source === "image"
            ? "calibration.bar.fromImage"
            : guess.source === "sign"
              ? "calibration.bar.fromSign"
              : "calibration.bar.fromExamples",
      ),
      warn: false,
    });
  if (single && answeredBy(single))
    notes.push({
      text: t(
        answeredBy(single) === "text"
          ? "calibration.bar.answeredText"
          : "calibration.bar.answeredExamples",
      ),
      warn: false,
    });

  // ── the selects that end a chip row ─────────────────────────────────────────
  const typeSelect = (
    <select
      key="type"
      aria-label={t("calibration.bar.anotherType")}
      title={t("calibration.bar.anotherType")}
      className={ROW_SELECT}
      disabled={disabled}
      value={typeValue}
      onChange={(event) => onSubtype(event.target.value === "__none" ? "" : event.target.value)}
    >
      <option value="" disabled>
        {t("calibration.bar.anotherType")}
      </option>
      {choices.map((value) => {
        const key = hotkeyOf(value);
        return (
          <option key={value} value={value}>
            {SUBTYPE_GLYPHS[value]} · {typeName(value)}
            {key ? ` · ${key}` : ""}
          </option>
        );
      })}
      <option value="__none">{t("calibration.subtypeNone")}</option>
    </select>
  );
  const pairSelect = (
    <select
      key="pair"
      aria-label={t("calibration.bar.addPart")}
      title={t("calibration.bar.addPartHelp")}
      className={cn(ROW_SELECT, "w-[92px] font-semibold")}
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
  );
  const touchingSelect = (
    <select
      aria-label={t("calibration.bar.chips.otherTouching")}
      title={t("calibration.fusedMarks.help")}
      className={ROW_SELECT}
      disabled={disabled}
      value=""
      onChange={(event) => {
        if (event.target.value) onContentsChip({ kind: "mark", name: event.target.value });
      }}
    >
      <option value="" disabled>
        {t("calibration.bar.chips.otherTouching")}
      </option>
      {SUBTYPES.filter((value) => value !== "other").map((value) => (
        <option key={value} value={value}>
          {SUBTYPE_GLYPHS[value]} · {typeName(value)}
        </option>
      ))}
    </select>
  );

  const libraryTitle = t("calibration.library.says");
  const segment = (on: boolean) =>
    cn(
      "h-7 cursor-pointer rounded-control px-3 text-[13px] transition-colors disabled:cursor-default disabled:opacity-50",
      on
        ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
        : "font-medium text-ink-2 hover:text-ink",
    );

  return (
    <Frame>
      {/* ── what is selected ── */}
      <div className="flex flex-none flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-rule-soft px-4 py-2">
        {single && line.image_url && (
          <BlobCrop
            url={line.image_url}
            x={single.x - line.bbox.x}
            y={single.y - line.bbox.y}
            w={single.w}
            h={single.h}
            box={32}
          />
        )}
        {single && (
          <span
            className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-[3px] text-[13px] font-semibold text-ink"
            style={{ background: `rgb(${ROLE_RGB[single.role].join(" ")} / 0.16)` }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: `rgb(${ROLE_RGB[single.role].join(",")})` }}
              aria-hidden="true"
            />
            {t(`calibration.role.${single.role}`)}
          </span>
        )}
        {headline && (
          <span dir="auto" className="font-display text-[17px] font-semibold leading-tight">
            {headline.name}
            {headline.glyph && (
              <span dir="rtl" className="ms-1.5 font-quran text-[19px] text-mark-text">
                {headline.glyph}
              </span>
            )}
          </span>
        )}
        {status && (
          <span
            className={cn(
              "rounded px-2 py-0.5 text-[12px] font-semibold",
              status.tone === "typed"
                ? "bg-lapis-wash text-lapis-text"
                : status.tone === "expected"
                  ? "border border-dashed border-gold-text text-gold-text"
                  : "bg-sunk text-ink-3",
            )}
          >
            {status.text}
          </span>
        )}
        {flags.map((flag) => {
          const label = attentionKey(flag);
          const help = attentionHelpKey(flag);
          return (
            <span
              key={flag}
              className="rounded bg-warn-wash px-1.5 py-0.5 text-[11.5px] text-warn-text"
              title={help ? t(help) : undefined}
            >
              {label ? t(label) : flag}
            </span>
          );
        })}
        <span className="font-mono text-[12px] text-ink-3">
          {single
            ? `${t("calibration.bar.where", {
                line: line.line_number,
                id: single.id,
                w: single.w,
                h: single.h,
              })} · ${t(`calibration.source.${single.decision_source}`)}`
            : t("calibration.bar.counts", { marks: marks.length, bodies: bodies.length })}
        </span>
        {texts.length > 0 && (
          <button
            type="button"
            aria-pressed={libraryOpen}
            title={t("calibration.bar.askLibraryHelp")}
            onClick={() => onLibraryOpen(!libraryOpen)}
            className={cn(TOGGLE, "ms-auto", libraryOpen ? TOGGLE_ON : TOGGLE_OFF)}
          >
            <BookOpen size={14} aria-hidden="true" />
            {t("calibration.bar.askLibrary")}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div
          className={cn(
            "grid h-full",
            libraryShown
              ? "min-w-[900px] grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.85fr)]"
              : "min-w-[640px] grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]",
          )}
        >
          {/* ── what it is, and what it holds ── */}
          <section
            aria-label={t("calibration.bar.whatItIs")}
            className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label={t("calibration.bar.roleGroup")}
                className="inline-flex rounded-lg bg-sunk p-[3px]"
              >
                {(["body", "mark"] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    aria-pressed={blobs.every((blob) => blob.role === choice)}
                    disabled={disabled}
                    onClick={() => onRole(choice)}
                    title={t(`calibration.key.${choice}`)}
                    className={segment(blobs.every((blob) => blob.role === choice))}
                  >
                    {t(`calibration.role.${choice}`)}
                    <Key>{choice === "body" ? "B" : "M"}</Key>
                  </button>
                ))}
                {structure && (
                  <button
                    type="button"
                    aria-pressed={blobs.every((blob) => blob.role === structure)}
                    disabled={disabled}
                    onClick={onGiveBack}
                    title={t(
                      structure === "symbol"
                        ? "calibration.bar.symbolAgainHelp"
                        : "calibration.bar.ornamentAgainHelp",
                    )}
                    className={segment(blobs.every((blob) => blob.role === structure))}
                  >
                    {t(`calibration.role.${structure}`)}
                  </button>
                )}
              </div>
              {texts.length > 0 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onErase(!erased)}
                  title={t(erased ? "calibration.bar.restoreHelp" : "calibration.bar.eraseHelp")}
                  className={cn(
                    "h-[34px] cursor-pointer rounded-control border px-2.5 text-[12.5px] font-semibold transition-colors disabled:cursor-default disabled:opacity-50",
                    suspicion
                      ? "border-stop bg-stop text-on-stop hover:bg-stop/90"
                      : "border-rule-2 bg-card text-ink hover:bg-sheet",
                  )}
                >
                  {t(erased ? "calibration.bar.restore" : "calibration.bar.erase")}
                  <Key>Del</Key>
                </button>
              )}
              {live.length > 0 && (
                <div
                  role="group"
                  aria-label={t("calibration.exception")}
                  className="ms-auto flex items-center gap-1.5"
                >
                  {(["broken", "uncertain"] as const).map((flag) => {
                    const on = live.every((blob) => blob.exception === flag);
                    return (
                      <button
                        key={flag}
                        type="button"
                        aria-pressed={on}
                        disabled={disabled}
                        title={t(`calibration.exceptionKind.${flag}`)}
                        onClick={() => onException(on ? "" : flag)}
                        className={cn(TOGGLE, on ? TOGGLE_ON : TOGGLE_OFF)}
                      >
                        {t(`calibration.bar.flag.${flag}`)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {!single && (breakdown.size > 0 || untyped > 0) && (
              <span className="flex flex-wrap gap-x-2.5 text-[12px] text-ink-2">
                {[...breakdown.entries()].map(([subtype, count]) => (
                  <span key={subtype}>
                    <span dir="rtl" className="font-quran text-mark-text">
                      {glyph(subtype)}
                    </span>{" "}
                    {typeName(subtype)} ×{count.typed + count.expected}
                    {count.expected > 0 && (
                      <span className="text-ink-3">
                        {" "}
                        {t("calibration.bar.expectedCount", { count: count.expected })}
                      </span>
                    )}
                  </span>
                ))}
                {untyped > 0 && (
                  <span className="text-ink-3">
                    {t("calibration.bar.untypedCount", { count: untyped })}
                  </span>
                )}
              </span>
            )}

            {oneText && !oneText.erased && (
              <ContentsChips
                line={line}
                blob={oneText}
                shown={oneText.role === "mark" ? (shown[0] ?? null) : null}
                disabled={disabled}
                onChip={onContentsChip}
                onAccept={onAccept}
                more={
                  oneText.role === "mark" ? (
                    <>
                      {typeSelect}
                      {pairSelect}
                    </>
                  ) : (
                    touchingSelect
                  )
                }
              />
            )}

            {!oneText && marks.length > 0 && (
              <ChipRow label={t("calibration.bar.chips.marks")}>
                {expected > 0 && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={onAccept}
                    title={t("calibration.key.accept")}
                    className="h-7 cursor-pointer rounded-control bg-lapis px-2.5 text-[12.5px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50"
                  >
                    {t("calibration.bar.acceptMany", { count: expected })}
                    <Key>A</Key>
                  </button>
                )}
                {typeSelect}
                {pairSelect}
              </ChipRow>
            )}

            {notes.length > 0 && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-md py-1.5 text-[12px] leading-snug",
                  notes[0].warn ? "bg-warn-wash px-2.5 text-warn-text" : "text-ink-3",
                )}
                title={notes.map((note) => note.text).join("\n\n")}
              >
                <span className="line-clamp-2 min-w-0 flex-1">{notes[0].text}</span>
                {notes.length > 1 && (
                  <span className="flex-none rounded bg-sunk px-1.5 font-mono text-[11px] text-ink-2">
                    +{notes.length - 1}
                  </span>
                )}
              </div>
            )}
          </section>

          {/* ── belongs to ── */}
          <section
            aria-label={t("calibration.belongsTo")}
            className="flex min-h-0 flex-col overflow-y-auto border-s border-rule-soft px-4 py-2.5"
          >
            <BelongsTo
              key={`${line.snapshot_id}:${blobs.map((blob) => blob.id).join(",")}`}
              line={line}
              blobs={blobs}
              checks={checks}
              disabled={disabled}
              knife={knife}
              onAssign={onAssign}
              onShare={onShare}
              onRelease={onRelease}
              onUnassign={onUnassign}
            />
          </section>

          {/* ── what the library says, while asked ── */}
          {libraryShown && (
            <section
              aria-label={libraryTitle}
              className="flex min-h-0 flex-col gap-2 overflow-y-auto border-s border-rule-soft bg-sheet px-4 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <PaneTitle>{libraryTitle}</PaneTitle>
                <button
                  type="button"
                  aria-label={t("calibration.bar.closeLibrary")}
                  title={t("calibration.bar.closeLibrary")}
                  onClick={() => onLibraryOpen(false)}
                  className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-control text-ink-3 hover:bg-card hover:text-ink"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <LibraryAnswer one={!!oneText} library={library} />
              {oneText && (
                <button
                  type="button"
                  onClick={onShowInLibrary}
                  className="mt-auto inline-flex h-[30px] flex-none cursor-pointer items-center justify-center self-start rounded-control border border-lapis bg-lapis-wash px-3 text-[12.5px] font-semibold text-lapis-text transition-colors hover:bg-lapis hover:text-on-lapis"
                >
                  {t("calibration.library.show")}
                </button>
              )}
            </section>
          )}
        </div>
      </div>

      <div className="flex flex-none flex-wrap gap-x-3.5 gap-y-1 border-t border-rule-soft bg-sheet px-4 py-1.5 text-[12px] text-ink-3">
        {(
          [
            ["← →", t("calibration.bar.hintBlob")],
            ["↑ ↓", t("calibration.bar.hintLine")],
            ["Ctrl ← →", t("calibration.bar.hintWord")],
            ["B · M", t("calibration.bar.keyRole")],
            ["1–9 0", t("calibration.bar.hintType")],
            ["A", t("calibration.bar.hintAccept")],
            ["N", t("calibration.bar.keyLook")],
            ["Ctrl S", t("calibration.bar.keySave")],
          ] as const
        ).map(([key, what]) => (
          <span key={key} className="whitespace-nowrap">
            <Kbd>{key}</Kbd> {what}
          </span>
        ))}
      </div>
    </Frame>
  );
}

/** The library's answer for the one selected blob: body or mark by the nearest letter
 * and mark, and a mark's type with its runner-up. */
function LibraryAnswer({
  one,
  library,
}: {
  one: boolean;
  library: { data: LibraryCompare | null; loading: boolean } | null;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  const quiet = "text-[12px] leading-snug text-ink-3";
  if (!one) return <p className={`m-0 ${quiet}`}>{t("calibration.library.oneBlob")}</p>;
  if (!library || (library.loading && !library.data))
    return <span className={quiet}>{t("calibration.library.asking")}</span>;
  const data = library.data;
  if (!data?.answer) return <span className={quiet}>{t("calibration.library.nothingYet")}</span>;
  return (
    <>
      <span className="text-[13px] leading-snug text-ink">
        <strong>{t(`calibration.role.${data.answer.role}`)}</strong>
        <span className="font-mono text-[12px] text-ink-3">
          {" · "}
          {t("calibration.library.nearestMark", {
            distance: data.answer.nearest_mark.toFixed(2),
          })}
          {" · "}
          {t("calibration.library.nearestLetter", {
            distance: data.answer.nearest_letter.toFixed(2),
          })}
        </span>
      </span>
      {data.type && (
        <span className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-snug">
          <span className="font-semibold text-ink">
            <span dir="rtl" className="font-quran text-mark-text">
              {glyph(data.type.kind)}
            </span>{" "}
            {typeName(data.type.kind)}
            {data.type.sure && " ★"}
          </span>
          {data.type.distance !== null && (
            <span className="font-mono text-[12px] text-ink-3">
              {data.type.distance.toFixed(2)}
            </span>
          )}
          {data.type.runner_up && (
            <span className="text-[12px] text-ink-3">
              {t("calibration.library.runnerUp", {
                type: typeName(data.type.runner_up),
                distance: data.type.runner_distance?.toFixed(2) ?? "—",
              })}
            </span>
          )}
        </span>
      )}
      {data.own > 0 && (
        <span className={quiet}>{t("calibration.library.ownCount", { count: data.own })}</span>
      )}
    </>
  );
}

/** The bar's card, set into the well under the strips, at its one height. */
function Frame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex-shrink-0 bg-well px-[18px] pb-3 pt-0.5">
      <section
        aria-label={t("calibration.bar.label")}
        className="flex flex-col overflow-hidden rounded-panel border border-rule bg-card"
        style={{ height: HEIGHT }}
      >
        {children}
      </section>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-rule-2 bg-card px-[5px] py-px font-mono text-[11px] text-ink">
      {children}
    </kbd>
  );
}

function PaneTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
      {children}
    </div>
  );
}

/** A key's letter, set small after a button's label. */
function Key({ children }: { children: string }) {
  return <kbd className="ms-1.5 font-mono text-[10.5px] opacity-60">{children}</kbd>;
}

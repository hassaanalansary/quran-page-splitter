import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  activeAttention,
  answeredBy,
  doubtOf,
  expectationKey,
  markCheckOf,
  noiseFor,
  shownType,
  typedByText,
  wordCount,
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

import { BlobCrop, OwnershipControls } from "./BlobDetails";
import { ROLE_RGB } from "./colors";
import { attentionHelpKey, attentionKey, useTypeName } from "./labels";
import { HOTKEY_TYPES, SUBTYPES, SUBTYPE_GLYPHS, hotkeyOf, subtypeGlyph } from "./subtypes";

/** Screen px the bar always takes — it never grows with what it says, so the lines
 * above it never jump. Each pane scrolls on its own when it has more to say. */
const HEIGHT = 262;

const glyph = subtypeGlyph;

/**
 * Everything about the selection, in one place under the lines, at one height.
 *
 *     ┌ picture · role · type · status · where, who decided ─────────────────────┐
 *     ├ what it is ──────────────┬ belongs to ─────────┬ library says ─────────┤
 *     │ Body|Mark  Erase         │ word · aya · PAWs   │ mark · nearest mark,  │
 *     │ Accept ‹type›  (A)       │ marks fit the text  │  nearest letter       │
 *     │ another type · + Pair    │ give it · share     │ kasra 0.31 · runner-up│
 *     │ doubt · flags            │ unattach · flag     │ [Show in Library]     │
 *     ├ ← → blob · ↑ ↓ line · Ctrl ← → word · B M · 1–9 0 · N · Ctrl S ──────────┤
 *
 * *Library says* is the fingerprint library's answer for the one selected blob —
 * body or mark from the nearest letter and mark, and a mark's type — with the way to
 * its full picture in the Library mode. The editor owns the draft, so it asks and
 * passes the answer in.
 */
export function SelectionBar({
  line,
  blobs,
  expectations,
  doubts,
  checks,
  noise,
  library,
  onShowInLibrary,
  disabled,
  onRole,
  onSubtype,
  onAddPart,
  onAccept,
  onException,
  onErase,
  onAssign,
  onShare,
  onRelease,
  onUnassign,
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
  /** Open the Library mode on this blob. */
  onShowInLibrary: () => void;
  disabled: boolean;
  onRole: (role: TextRole) => void;
  onSubtype: (subtype: string) => void;
  /** Add a type to the marks' own, or take it off: marks printed as one blob. */
  onAddPart: (part: string) => void;
  onAccept: () => void;
  onException: (exception: BlobException) => void;
  /** Erase the selected ink, or restore it. */
  onErase: (erased: boolean) => void;
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
  // Every type in one list, the hotkeyed ones first with their key.
  const choices = [...HOTKEY_TYPES, ...SUBTYPES.filter((value) => !hotkeyOf(value))];
  const typeValue =
    marks.length > 0 && choices.some((value) => typedAs(value)) ? marks[0].subtype : "";
  const oneText = single && (single.role === "body" || single.role === "mark") ? single : null;
  const texts = blobs.filter((blob) => blob.role === "body" || blob.role === "mark");
  /** Every text blob selected is erased: the button restores them. */
  const erased = texts.length > 0 && texts.every((blob) => blob.erased);
  const suspicion = single ? noiseFor(single, line.snapshot_id, noise) : null;

  // ── what it is ─────────────────────────────────────────────────────────────
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

  const notice = "rounded-md bg-warn-wash px-2.5 py-1.5 text-[12px] leading-snug text-warn-text";
  const quiet = "text-[12px] leading-snug text-ink-3";
  const control =
    "h-[34px] min-w-0 cursor-pointer rounded-control border border-rule-2 bg-card px-2 text-[13px] text-ink outline-none focus:border-lapis disabled:cursor-default disabled:opacity-50";

  return (
    <Frame>
      {/* ── what is selected ── */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-rule-soft px-4 py-2.5">
        {single && line.image_url && (
          <BlobCrop
            url={line.image_url}
            x={single.x - line.bbox.x}
            y={single.y - line.bbox.y}
            w={single.w}
            h={single.h}
            box={36}
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
          <span dir="auto" className="font-display text-[18px] font-semibold leading-tight">
            {headline.name}
            {headline.glyph && (
              <span dir="rtl" className="ms-1.5 font-quran text-[20px] text-mark-text">
                {headline.glyph}
              </span>
            )}
          </span>
        )}
        {status && (
          <span
            className={`rounded px-2 py-0.5 text-[12px] font-semibold ${
              status.tone === "typed"
                ? "bg-lapis-wash text-lapis-text"
                : status.tone === "expected"
                  ? "border border-dashed border-gold-text text-gold-text"
                  : "bg-sunk text-ink-3"
            }`}
          >
            {status.text}
          </span>
        )}
        <span className="font-mono text-[12.5px] text-ink-3">
          {single
            ? `${t("calibration.bar.where", {
                line: line.line_number,
                id: single.id,
                w: single.w,
                h: single.h,
              })} · ${t(`calibration.source.${single.decision_source}`)}`
            : t("calibration.bar.counts", { marks: marks.length, bodies: bodies.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="grid h-full min-w-[760px] grid-cols-3">
          {/* ── what it is ── */}
          <section className="flex min-h-0 flex-col gap-2.5 overflow-y-auto border-e border-rule-soft px-4 py-3">
            <PaneTitle>{t("calibration.bar.whatItIs")}</PaneTitle>
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

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label={t("calibration.bar.roleGroup")}
                className="inline-flex rounded-lg bg-sunk p-[3px]"
              >
                {(["body", "mark"] as const).map((choice) => {
                  const on = blobs.every((blob) => blob.role === choice);
                  return (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={on}
                      disabled={disabled}
                      onClick={() => onRole(choice)}
                      title={t(`calibration.key.${choice}`)}
                      className={`h-7 cursor-pointer rounded-control px-3 text-[13px] transition-colors disabled:cursor-default disabled:opacity-50 ${
                        on
                          ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                          : "font-medium text-ink-2 hover:text-ink"
                      }`}
                    >
                      {t(`calibration.role.${choice}`)}
                      <Key>{choice === "body" ? "B" : "M"}</Key>
                    </button>
                  );
                })}
              </div>
              {texts.length > 0 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onErase(!erased)}
                  title={t(erased ? "calibration.bar.restoreHelp" : "calibration.bar.eraseHelp")}
                  className={`h-[34px] cursor-pointer rounded-control border px-2.5 text-[12.5px] font-semibold transition-colors disabled:cursor-default disabled:opacity-50 ${
                    suspicion
                      ? "border-stop bg-stop text-on-stop hover:bg-stop/90"
                      : "border-rule-2 bg-card text-ink hover:bg-sheet"
                  }`}
                >
                  {t(erased ? "calibration.bar.restore" : "calibration.bar.erase")}
                  <Key>Del</Key>
                </button>
              )}
            </div>

            {expected > 0 && (
              <button
                type="button"
                disabled={disabled}
                onClick={onAccept}
                title={t("calibration.key.accept")}
                className="h-10 flex-none cursor-pointer rounded-control bg-lapis px-3 text-[13.5px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50"
              >
                {single && shown[0]
                  ? t("calibration.bar.acceptOne", { type: typeName(shown[0].subtype) })
                  : t("calibration.bar.acceptMany", { count: expected })}
                <Key>A</Key>
              </button>
            )}

            {marks.length > 0 && (
              <div className="flex gap-2">
                <select
                  aria-label={t("calibration.bar.anotherType")}
                  title={t("calibration.bar.anotherType")}
                  className={`${control} flex-1`}
                  disabled={disabled}
                  value={typeValue}
                  onChange={(event) =>
                    onSubtype(event.target.value === "__none" ? "" : event.target.value)
                  }
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
                <select
                  aria-label={t("calibration.bar.addPart")}
                  title={t("calibration.bar.addPartHelp")}
                  className={`${control} w-[96px] flex-none font-semibold`}
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

            {single?.erased && <span className={quiet}>{t("calibration.bar.erasedHelp")}</span>}
            {suspicion && (
              <div className={notice}>
                {t(`calibration.noise.${suspicion.kind}Help`)}
                {suspicion.edge ? ` ${t("calibration.noise.edgeHelp")}` : ""}
              </div>
            )}
            {status?.tone === "expected" && guess?.source && (
              <span className={quiet}>
                {t(
                  guess.source === "text"
                    ? "calibration.bar.fromText"
                    : guess.source === "image"
                      ? "calibration.bar.fromImage"
                      : guess.source === "sign"
                        ? "calibration.bar.fromSign"
                        : "calibration.bar.fromExamples",
                )}
              </span>
            )}
            {guess?.text && (
              <div className={notice}>
                {t("calibration.bar.textConflict", {
                  type: `${glyph(guess.text)} ${typeName(guess.text)}`,
                })}
              </div>
            )}
            {doubt && (
              <div className={notice}>
                {t(
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
                )}
              </div>
            )}
            {single && answeredBy(single) && (
              <span className={quiet}>
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
                      className="rounded bg-warn-wash px-1.5 py-0.5 text-[11.5px] text-warn-text"
                      title={help ? t(help) : undefined}
                    >
                      {label ? t(label) : flag}
                    </span>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── belongs to ── */}
          <section className="flex min-h-0 flex-col gap-2.5 overflow-y-auto border-e border-rule-soft px-4 py-3">
            <PaneTitle>{t("calibration.belongsTo")}</PaneTitle>
            <div className="flex flex-col gap-1.5">
              {owners.length === 0 ? (
                <span className="text-[13px] text-ink-3">{t("calibration.bar.noWord")}</span>
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
                    <div key={id} className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2.5">
                        <span lang="ar" dir="rtl" className="font-quran text-[24px] leading-snug">
                          {word?.text ?? `#${id}`}
                        </span>
                        {word && (
                          <span dir="ltr" className="font-mono text-[12px] text-ink-3">
                            {word.aya}
                          </span>
                        )}
                        {count && (
                          <span
                            className={`rounded px-1.5 py-px font-mono text-[11.5px] font-semibold ${
                              count.ok ? "bg-sunk text-ink-2" : "bg-warn text-on-warn"
                            }`}
                            title={t("calibration.countHelp")}
                          >
                            {count.got}/{count.want}
                          </span>
                        )}
                      </span>
                      {check && (
                        <span
                          className={`text-[13px] leading-snug ${
                            check.ok ? "font-semibold text-done-text" : "text-warn-text"
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
            <span className="text-[12px] leading-[1.45] text-ink-3">
              {t("calibration.bar.ownershipNote")}
            </span>
          </section>

          {/* ── what the library says ── */}
          <section className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-3">
            <PaneTitle>{t("calibration.library.says")}</PaneTitle>
            {!oneText ? (
              <p className={`m-0 ${quiet}`}>{t("calibration.library.oneBlob")}</p>
            ) : !library || (library.loading && !library.data) ? (
              <span className={quiet}>{t("calibration.library.asking")}</span>
            ) : !library.data?.answer ? (
              <span className={quiet}>{t("calibration.library.nothingYet")}</span>
            ) : (
              <>
                <span className="text-[13px] leading-snug text-ink">
                  <strong>{t(`calibration.role.${library.data.answer.role}`)}</strong>
                  <span className="font-mono text-[12px] text-ink-3">
                    {" · "}
                    {t("calibration.library.nearestMark", {
                      distance: library.data.answer.nearest_mark.toFixed(2),
                    })}
                    {" · "}
                    {t("calibration.library.nearestLetter", {
                      distance: library.data.answer.nearest_letter.toFixed(2),
                    })}
                  </span>
                </span>
                {library.data.type && (
                  <span className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-snug">
                    <span className="font-semibold text-ink">
                      <span dir="rtl" className="font-quran text-mark-text">
                        {glyph(library.data.type.subtype)}
                      </span>{" "}
                      {typeName(library.data.type.subtype)}
                      {library.data.type.sure && " ★"}
                    </span>
                    {library.data.type.distance !== null && (
                      <span className="font-mono text-[12px] text-ink-3">
                        {library.data.type.distance.toFixed(2)}
                      </span>
                    )}
                    {library.data.type.runner_up && (
                      <span className="text-[12px] text-ink-3">
                        {t("calibration.library.runnerUp", {
                          type: typeName(library.data.type.runner_up),
                          distance: library.data.type.runner_distance?.toFixed(2) ?? "—",
                        })}
                      </span>
                    )}
                  </span>
                )}
                {library.data.own.length > 0 && (
                  <span className={quiet}>
                    {t("calibration.library.ownCount", { count: library.data.own.length })}
                  </span>
                )}
              </>
            )}
            {oneText && (
              <button
                type="button"
                onClick={onShowInLibrary}
                className="mt-auto inline-flex h-[34px] flex-none cursor-pointer items-center justify-center self-start rounded-control border border-lapis bg-lapis-wash px-3 text-[12.5px] font-semibold text-lapis-text transition-colors hover:bg-lapis hover:text-on-lapis"
              >
                {t("calibration.library.show")}
              </button>
            )}
          </section>
        </div>
      </div>

      <div className="flex flex-none flex-wrap gap-x-3.5 gap-y-1 border-t border-rule-soft bg-sheet px-4 py-2 text-[12px] text-ink-3">
        {(
          [
            ["← →", t("calibration.bar.hintBlob")],
            ["↑ ↓", t("calibration.bar.hintLine")],
            ["Ctrl ← →", t("calibration.bar.hintWord")],
            ["B · M", t("calibration.bar.keyRole")],
            ["1–9 0", t("calibration.bar.hintType")],
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

import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  activeAttention,
  doubtOf,
  shownType,
  wordCount,
  type Doubts,
  type Expectations,
} from "@/lib/calibration/model";
import type {
  CalibrationBlob,
  CalibrationLine,
  TextRole,
  TypeEvidence,
} from "@/lib/calibration/types";

import { BlobCrop } from "./BlobInspector";
import { attentionHelpKey, attentionKey, subtypeKey } from "./labels";
import {
  HOTKEY_TYPES,
  SUBTYPES,
  SUBTYPE_GLYPHS,
  SUBTYPE_MARKS,
  hotkeyOf,
  type Subtype,
} from "./subtypes";

const glyph = (subtype: string) => SUBTYPE_MARKS[subtype as Subtype] ?? "?";

/**
 * What is selected, said plainly, in one place under the lines: what the ink is,
 * which type it is or is expected to be, which word it belongs to, what asks for a
 * second look — and the decisions made most often, each with its key.
 *
 * For a single mark, the evidence beside it: the types nearest it, each with its own
 * nearest typed examples — pictures to judge the guess by, and a way to the page a
 * wrongly typed example came from. Asked for by the editor, which owns the draft.
 */
export function SelectionBar({
  mushafId,
  line,
  blobs,
  expectations,
  doubts,
  evidence,
  disabled,
  onRole,
  onSubtype,
  onAccept,
}: {
  mushafId: string;
  line: CalibrationLine | null;
  blobs: CalibrationBlob[];
  expectations: Expectations;
  doubts: Doubts;
  /** Null when there is nothing to explain: no single mark selected. */
  evidence: { data: TypeEvidence | null; loading: boolean } | null;
  disabled: boolean;
  onRole: (role: TextRole) => void;
  onSubtype: (subtype: string) => void;
  onAccept: () => void;
}) {
  const { t } = useTranslation();
  const typeName = (subtype: string) => {
    const key = subtypeKey(subtype);
    return key ? t(key) : subtype;
  };

  if (!line || !blobs.length) {
    return (
      <div className="flex-shrink-0 border-t border-border bg-white px-3 py-2.5">
        <p className="text-[11.5px] leading-relaxed text-text-muted">
          {t("calibration.bar.empty")}
        </p>
      </div>
    );
  }

  const single = blobs.length === 1 ? blobs[0] : null;
  const marks = blobs.filter((blob) => blob.role === "mark");
  const bodies = blobs.filter((blob) => blob.role === "body");
  const shown = marks.map((blob) => shownType(blob, line.snapshot_id, expectations));
  const expected = shown.filter((type) => type && !type.typed).length;
  const typedAs = (subtype: string) =>
    marks.length > 0 && marks.every((blob, i) => shown[i]?.typed && shown[i]?.subtype === subtype);
  const expectedAs = (subtype: string) =>
    shown.some((type) => type && !type.typed && type.subtype === subtype);
  const doubt = single ? doubtOf(single, line.snapshot_id, doubts) : null;
  const flags = [...new Set(blobs.flatMap(activeAttention))];
  const wordOf = (id: number) => line.words.find((word) => word.word_id === id);
  const owners = [...new Set(blobs.flatMap((blob) => blob.allocations.map((a) => a.word_id)))];
  const others = SUBTYPES.filter((value) => !hotkeyOf(value));
  const otherValue = marks.length && others.some((value) => typedAs(value)) ? marks[0].subtype : "";

  // ── what it is ─────────────────────────────────────────────────────────────
  let headline: string;
  let status: { text: string; tone: "typed" | "expected" | "none" } | null = null;
  if (single) {
    const type = shown[0] ?? null;
    headline = t(`calibration.role.${single.role}`);
    if (single.role === "mark" && type) {
      headline += ` · ${glyph(type.subtype)} ${typeName(type.subtype)}`;
      status = type.typed
        ? { text: t("calibration.bar.typed"), tone: "typed" }
        : {
            text: t(type.sure ? "calibration.bar.expectedSure" : "calibration.bar.expectedLikely"),
            tone: "expected",
          };
    } else if (single.role === "mark") {
      status = { text: t("calibration.bar.noType"), tone: "none" };
    }
  } else {
    headline = t("calibration.inspectorMany", { count: blobs.length, line: line.line_number });
  }

  // How the selected marks divide by type, for more than one.
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
    <div className="flex-shrink-0 border-t border-border bg-white px-3 py-2">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {single && line.image_url && (
          <BlobCrop
            url={line.image_url}
            x={single.x - line.bbox.x}
            y={single.y - line.bbox.y}
            w={single.w}
            h={single.h}
            box={64}
          />
        )}

        <div className="flex min-w-[280px] flex-1 flex-col gap-1.5">
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
            <span className="ms-auto text-[10.5px] tabular-nums text-text-muted">
              {single
                ? t("calibration.bar.where", {
                    line: line.line_number,
                    id: single.id,
                    w: single.w,
                    h: single.h,
                  })
                : t("calibration.bar.counts", { marks: marks.length, bodies: bodies.length })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-text-secondary">
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span className="text-text-muted">{t("calibration.belongsTo")}:</span>
              {owners.length === 0 ? (
                <span>{t("calibration.bar.noWord")}</span>
              ) : (
                owners.map((id) => {
                  const word = wordOf(id);
                  const count = word ? wordCount(line, word) : null;
                  return (
                    <span key={id} className="flex items-center gap-1">
                      <span dir="rtl" className="text-[14px] text-text-primary">
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
                  );
                })
              )}
            </span>
            {single && (
              <span className="text-[11px] text-text-muted">
                {t(`calibration.source.${single.decision_source}`)}
              </span>
            )}
            {!single &&
              [...breakdown.entries()].map(([subtype, count]) => (
                <span key={subtype} className="text-[11px]">
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
            {!single && untyped > 0 && (
              <span className="text-[11px] text-text-muted">
                {t("calibration.bar.untypedCount", { count: untyped })}
              </span>
            )}
          </div>

          {doubt && (
            <div className="rounded-sm bg-warning-bg px-2 py-1 text-[11.5px] leading-snug text-[#8a4b0d]">
              {t(doubt.sure ? "calibration.bar.doubtSure" : "calibration.bar.doubt", {
                typed: typeName(doubt.typed),
                type: `${glyph(doubt.subtype)} ${typeName(doubt.subtype)}`,
              })}
            </div>
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
            {(["body", "mark"] as const).map((choice) => {
              const on = blobs.every((blob) => blob.role === choice);
              return (
                <Button
                  key={choice}
                  type="button"
                  variant={on ? "default" : "outline"}
                  className="h-7 px-2 text-[12px]"
                  disabled={disabled}
                  onClick={() => onRole(choice)}
                  title={t(`calibration.key.${choice}`)}
                >
                  {t(`calibration.role.${choice}`)}
                  <Key>{choice === "body" ? "B" : "M"}</Key>
                </Button>
              );
            })}

            {marks.length > 0 && (
              <>
                <span className="mx-1 h-5 w-px flex-none bg-border" />
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
              </>
            )}

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
        </div>

        {evidence && single && (
          <div className="flex w-[330px] max-w-full flex-none flex-col gap-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
              {t(
                evidence.data?.typed
                  ? "calibration.bar.evidenceElsewhere"
                  : "calibration.bar.evidence",
              )}
            </div>
            {evidence.loading && !evidence.data ? (
              <span className="text-[11px] text-text-muted">
                {t("calibration.bar.loadingEvidence")}
              </span>
            ) : !evidence.data?.candidates.length ? (
              <span className="text-[11px] text-text-muted">{t("calibration.bar.noEvidence")}</span>
            ) : (
              evidence.data.candidates.map((candidate, index) => (
                <div key={candidate.subtype} className="flex items-center gap-1.5">
                  <span
                    className={`w-[104px] flex-none truncate text-[11.5px] ${
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
                      <BlobCrop url={example.image_url} {...example.crop} box={34} />
                    </Link>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>
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

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  type ContentsChip,
  layWordPieces,
  nextPieceRun,
  subtypeParts,
} from "@/lib/calibration/model";
import type { CalibrationBlob, CalibrationLine } from "@/lib/calibration/types";
import { cn } from "@/lib/utils";

import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

const CHIP =
  "inline-flex h-7 cursor-pointer items-center gap-1 rounded-control border px-2 text-[12.5px] transition-colors disabled:cursor-default disabled:opacity-50";
const TICKED = "border-lapis bg-lapis-wash font-semibold text-lapis-text";
const OPEN = "border-rule-2 bg-card text-ink-2 hover:border-lapis hover:text-ink";
const EXPECTED = "border-dashed border-gold-text text-gold-text hover:bg-sunk";

/** What a mark's type is shown as: typed, or only expected. */
export type ShownMarkType = { subtype: string; typed: boolean } | null;

/** One labelled row of chips. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-[68px] flex-none text-[12px] text-ink-3">{label}</span>
      {children}
    </div>
  );
}

/** The labeling bar: what one text blob holds, as chips its word's text offers.
 *
 * A body: its word's pieces (which of them it holds — a click on a piece takes it,
 * one beside the ticked ones joins them, an end one leaves) and the marks the text
 * names on those letters (which of them are printed touching it). A mark: the types
 * its word's text names — the one it is typed solid, the one only expected dashed,
 * accepted with a click or A. `more` ends the marks row: the way to a type the text
 * does not name. A tick is what the blob holds now; a click is a person's decision. */
export function ContentsChips({
  line,
  blob,
  shown,
  disabled,
  onChip,
  onAccept,
  more,
}: {
  line: CalibrationLine;
  blob: CalibrationBlob;
  /** A mark's type as the bar shows it; null for a body, or a mark with none. */
  shown: ShownMarkType;
  disabled: boolean;
  onChip: (chip: ContentsChip) => void;
  /** Accept the expected type of the selected mark. */
  onAccept: () => void;
  more?: ReactNode;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  const isBody = blob.role === "body";
  const owner = blob.allocations.length === 1 ? blob.allocations[0] : null;
  const word = owner
    ? line.words.find((candidate) => candidate.word_id === owner.word_id)
    : undefined;
  const pieces = word?.pieces ?? [];
  // Which pieces it holds: where it sits among its word's bodies, as the reader lays
  // them out — so a body given none, or the wrong one, still shows where it is.
  const run =
    isBody && owner && pieces.length
      ? layWordPieces(line, owner.word_id, pieces.length).runs.find(
          (candidate) => candidate.id === blob.id,
        )
      : undefined;
  const start = run?.start ?? 0;
  const count = run ? run.end - run.start : 0;
  const starts: number[] = [];
  let seen = 0;
  for (const piece of pieces) {
    starts.push(seen);
    seen += piece.length;
  }
  const first = starts[start] ?? seen;
  const last = start + count < starts.length ? starts[start + count] : seen;
  const offered = [
    ...new Set(
      (word?.text_marks ?? [])
        .filter((mark) => !isBody || (mark.letter >= first && mark.letter < last))
        .map((mark) => mark.kind),
    ),
  ];
  const ticked = isBody
    ? blob.exception === "mixed"
      ? subtypeParts(blob.subtype)
      : []
    : shown?.typed
      ? subtypeParts(shown.subtype)
      : [];
  const expected = !isBody && shown && !shown.typed ? subtypeParts(shown.subtype) : [];
  const marks = [...new Set([...offered, ...ticked, ...expected])];

  const choosePiece = (index: number) => {
    if (!owner) return;
    const next = nextPieceRun(start, start + count, index);
    if (next) onChip({ kind: "pieces", wordId: owner.word_id, start: next[0], end: next[1] });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {isBody && owner && pieces.length > 0 && (
        <ChipRow label={t("calibration.bar.chips.letters")}>
          {pieces.map((piece, index) => {
            const on = index >= start && index < start + count;
            return (
              <button
                key={`${piece}:${index}`}
                type="button"
                dir="rtl"
                disabled={disabled}
                aria-pressed={on}
                title={t("calibration.bar.chips.lettersHelp")}
                className={cn(CHIP, "font-quran text-[17px] leading-none", on ? TICKED : OPEN)}
                onClick={() => choosePiece(index)}
              >
                {piece}
              </button>
            );
          })}
        </ChipRow>
      )}
      <ChipRow label={t(isBody ? "calibration.bar.chips.touching" : "calibration.bar.chips.marks")}>
        {marks.map((kind) => {
          const on = ticked.includes(kind);
          const waiting = expected.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              title={waiting ? t("calibration.key.accept") : undefined}
              className={cn(CHIP, on ? TICKED : waiting ? EXPECTED : OPEN)}
              onClick={() => (waiting ? onAccept() : onChip({ kind: "mark", name: kind }))}
            >
              <span dir="rtl" className="font-quran text-[15px] leading-none text-mark-text">
                {subtypeGlyph(kind)}
              </span>
              {typeName(kind)}
              {waiting && <kbd className="ms-0.5 font-mono text-[10.5px] opacity-70">A</kbd>}
            </button>
          );
        })}
        {!marks.length && (
          <span className="text-[12px] text-ink-3">
            {t(isBody ? "calibration.bar.chips.noneTouching" : "calibration.bar.chips.noneNamed")}
          </span>
        )}
        {more}
      </ChipRow>
    </div>
  );
}

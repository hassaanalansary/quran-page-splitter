import { useTranslation } from "react-i18next";

import { type ContentsChip, subtypeParts } from "@/lib/calibration/model";
import type { CalibrationBlob, CalibrationLine } from "@/lib/calibration/types";
import { cn } from "@/lib/utils";

import { useTypeName } from "./labels";

const CHIP =
  "inline-flex h-7 items-center gap-1 rounded-control border px-2 text-[12.5px] disabled:opacity-50";
const TICKED = "border-lapis bg-lapis/10 text-ink";
const OPEN = "border-rule-2 bg-card text-ink-3 hover:border-lapis";

/** The labeling bar: what one text blob holds, as chips its word's text offers — the
 * word's pieces for a body (how many it holds), and the marks the text names on its
 * letters (which of them touch it); for a mark, the types the word's text names. A tick
 * is what the blob holds now; a click is a person's decision. */
export function ContentsChips({
  line,
  blob,
  disabled,
  onChip,
}: {
  line: CalibrationLine;
  blob: CalibrationBlob;
  disabled: boolean;
  onChip: (chip: ContentsChip) => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  const owner = blob.allocations.length === 1 ? blob.allocations[0] : null;
  const word = owner
    ? line.words.find((candidate) => candidate.word_id === owner.word_id)
    : undefined;
  if (!owner || !word?.pieces?.length) return null;
  const pieces = word.pieces;
  const held = blob.contents?.paws ?? [];
  const count = blob.role === "body" ? Math.max(owner.paws, 1) : 0;
  const found = held.length ? pieces.indexOf(held[0] ?? "") : -1;
  const start = Math.max(0, Math.min(found < 0 ? 0 : found, pieces.length - count));
  const starts: number[] = [];
  let seen = 0;
  for (const piece of pieces) {
    starts.push(seen);
    seen += piece.length;
  }
  const first = starts[start] ?? 0;
  const last = start + count < starts.length ? starts[start + count] : seen;
  const offered = [
    ...new Set(
      (word.text_marks ?? [])
        .filter((mark) => blob.role === "mark" || (mark.letter >= first && mark.letter < last))
        .map((mark) => mark.kind),
    ),
  ];
  const ticked =
    blob.role === "mark"
      ? subtypeParts(blob.subtype)
      : blob.exception === "mixed"
        ? subtypeParts(blob.subtype)
        : [];
  const marks = [...new Set([...offered, ...ticked])];

  const choosePiece = (index: number) => {
    if (index === start - 1 || index === start + count)
      onChip({ kind: "pieces", count: count + 1, wordId: owner.word_id });
    else if (count > 1 && (index === start || index === start + count - 1))
      onChip({ kind: "pieces", count: count - 1, wordId: owner.word_id });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {blob.role === "body" && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 text-[12px] text-ink-3">{t("calibration.bar.chips.letters")}</span>
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
                className={cn(CHIP, "font-quran text-[16px]", on ? TICKED : OPEN)}
                onClick={() => choosePiece(index)}
              >
                {piece}
              </button>
            );
          })}
        </div>
      )}
      {marks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 text-[12px] text-ink-3">
            {t(
              blob.role === "body"
                ? "calibration.bar.chips.touching"
                : "calibration.bar.chips.marks",
            )}
          </span>
          {marks.map((kind) => {
            const on = ticked.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                className={cn(CHIP, on ? TICKED : OPEN)}
                onClick={() => onChip({ kind: "mark", name: kind })}
              >
                {typeName(kind)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

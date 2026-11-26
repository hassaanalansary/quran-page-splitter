import { Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cutFitsBlob } from "@/lib/calibration/blobCuts";
import { markCheckOf, wordCount, type MarkChecks } from "@/lib/calibration/model";
import type { Allocation, CalibrationBlob, CalibrationLine } from "@/lib/calibration/types";
import { cn } from "@/lib/utils";

import type { KnifeControls } from "./BlobDetails";
import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

/** A small outlined button. */
const ACTION =
  "inline-flex h-[30px] flex-none cursor-pointer items-center gap-1.5 rounded-control border border-rule-2 bg-card px-2.5 text-[12.5px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:text-ink-4";
const SELECT =
  "h-[30px] min-w-0 max-w-[220px] cursor-pointer rounded-control border border-rule-2 bg-card px-2 text-[12.5px] text-ink outline-none focus:border-lapis disabled:cursor-default disabled:opacity-50";
const PIECES_INPUT =
  "h-[26px] w-12 flex-none rounded-control border border-rule-2 bg-card px-1.5 font-mono text-[12.5px] text-ink outline-none focus:border-lapis";

/**
 * Which word the selected ink belongs to, and the ways to change it, all in sight:
 * each owner word with its aya, its piece count and whether its marks fit its text;
 * move it to another word; share a body with the word beside it, and cut it with the
 * knife where the two meet; leave marks unattached; take decisions back. What a blob
 * holds — its pieces, its marks — is said by the chips beside this, not here.
 */
export function BelongsTo({
  line,
  blobs,
  checks,
  disabled,
  knife,
  onAssign,
  onShare,
  onRelease,
  onUnassign,
}: {
  line: CalibrationLine;
  blobs: CalibrationBlob[];
  checks: MarkChecks;
  disabled: boolean;
  knife: KnifeControls;
  onAssign: (wordId: number, paws: number) => void;
  onShare: (shares: Allocation[]) => void;
  onRelease: () => void;
  onUnassign: () => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  const single = blobs.length === 1 ? blobs[0] : null;
  const labelled = line.words.filter((word) => word.word_id !== null);
  const owners = [...new Set(blobs.flatMap((blob) => blob.allocations.map((a) => a.word_id)))];
  const bodies = blobs.some((blob) => blob.role === "body");
  const marks = blobs.filter((blob) => blob.role === "mark");
  const attached = marks.filter((blob) => blob.allocations.length > 0);
  const decided = blobs.some((blob) => blob.explicit || blob.ownership_explicit);
  const shared = single?.role === "body" && single.allocations.length > 1 ? single : null;
  const owner = single?.allocations.length === 1 ? single.allocations[0] : null;
  const at = labelled.findIndex((word) => word.word_id === owner?.word_id);
  const neighbours =
    single?.role === "body" && at >= 0
      ? labelled.filter(
          (word, index) => Math.abs(index - at) === 1 && word.aya === labelled[at].aya,
        )
      : [];
  /** A body moved keeps the pieces it holds; the chips change them after. */
  const keep = single?.role === "body" ? Math.max(1, owner?.paws ?? 1) : 1;
  const sharePieces = (wordId: number, value: string) =>
    shared &&
    onShare(
      shared.allocations.map((allocation) =>
        allocation.word_id === wordId
          ? { ...allocation, paws: Math.max(0, Math.min(8, Math.round(Number(value) || 0))) }
          : allocation,
      ),
    );

  return (
    <div className="flex flex-col gap-2">
      {owners.length === 0 && (
        <span className="text-[13px] text-ink-3">{t("calibration.bar.noWord")}</span>
      )}
      {owners.map((id) => {
        const word = line.words.find((candidate) => candidate.word_id === id);
        const count = word ? wordCount(line, word) : null;
        const check = markCheckOf(line.snapshot_id, id, checks);
        const unfit = check
          ? [
              check.missing.length
                ? t("calibration.bar.marksMissing", {
                    types: check.missing
                      .map((kind) => `${subtypeGlyph(kind)} ${typeName(kind)}`)
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
        const share = shared?.allocations.find((allocation) => allocation.word_id === id);
        return (
          <div key={id} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <span lang="ar" dir="rtl" className="font-quran text-[22px] leading-snug">
              {word?.text ?? `#${id}`}
            </span>
            {word && (
              <span dir="ltr" className="font-mono text-[12px] text-ink-3">
                {word.aya}
              </span>
            )}
            {count && (
              <span
                className={cn(
                  "rounded px-1.5 py-px font-mono text-[11.5px] font-semibold",
                  count.ok ? "bg-sunk text-ink-2" : "bg-warn text-on-warn",
                )}
                title={t("calibration.countHelp")}
              >
                {count.got}/{count.want}
              </span>
            )}
            {share && (
              <input
                type="number"
                min={0}
                max={8}
                step={1}
                value={share.paws}
                disabled={disabled}
                title={t("calibration.pawsHelp")}
                aria-label={`${word?.text ?? id}: ${t("calibration.paws")}`}
                className={PIECES_INPUT}
                onChange={(event) => sharePieces(id, event.target.value)}
              />
            )}
            {check && (
              <span
                className={cn(
                  "text-[12.5px] leading-snug",
                  check.ok ? "font-semibold text-done-text" : "text-warn-text",
                )}
                title={t("calibration.bar.marksHelp")}
              >
                {check.ok ? t("calibration.bar.marksFit") : unfit.join(" · ")}
              </span>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={SELECT}
          value=""
          disabled={disabled || !labelled.length}
          aria-label={t("calibration.assignTitle")}
          title={t("calibration.bar.ownershipNote")}
          onChange={(event) => {
            if (event.target.value) onAssign(Number(event.target.value), bodies ? keep : 0);
          }}
        >
          <option value="" disabled>
            {t("calibration.bar.moveTo")}
          </option>
          {labelled.map((word) => (
            <option
              key={word.word_id}
              value={word.word_id!}
              disabled={owners.length === 1 && owners[0] === word.word_id}
            >
              {word.text} · {word.aya}
            </option>
          ))}
        </select>
        {single?.role === "body" &&
          single.allocations.length === 1 &&
          neighbours.map((word) => (
            <button
              key={word.word_id}
              type="button"
              className={ACTION}
              disabled={disabled}
              title={t("calibration.shareHelp")}
              onClick={() =>
                onShare([{ ...single.allocations[0] }, { word_id: word.word_id!, paws: 1 }])
              }
            >
              {t("calibration.bar.shareWith")}
              <span dir="rtl" className="font-quran text-[15px] font-normal leading-none">
                {word.text}
              </span>
            </button>
          ))}
        {attached.length > 0 && (
          <button type="button" className={ACTION} disabled={disabled} onClick={onUnassign}>
            {t("calibration.bar.leaveUnattached", { count: attached.length })}
          </button>
        )}
      </div>

      {shared && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={cn(
              ACTION,
              knife.active && "border-[color:var(--ov-warn)] text-[color:var(--ov-warn)]",
            )}
            aria-pressed={knife.active}
            disabled={disabled}
            title={t("calibration.knife.help")}
            onClick={knife.onToggle}
          >
            <Scissors size={14} aria-hidden="true" />
            {knife.active
              ? t("calibration.knife.stop")
              : t(cutFitsBlob(shared) ? "calibration.knife.recut" : "calibration.knife.start")}
          </button>
          {cutFitsBlob(shared) && !knife.active && (
            <>
              <button type="button" className={ACTION} disabled={disabled} onClick={knife.onSwap}>
                {t("calibration.knife.swap")}
              </button>
              <button type="button" className={ACTION} disabled={disabled} onClick={knife.onClear}>
                {t("calibration.knife.clear")}
              </button>
            </>
          )}
          <span
            className="min-w-0 basis-full text-[12px] leading-snug text-ink-3"
            style={{ color: knife.note ? "var(--ov-warn)" : undefined }}
            role={knife.note ? "status" : undefined}
          >
            {knife.active
              ? t(knife.note ? `calibration.knife.note.${knife.note}` : "calibration.knife.draw")
              : t(
                  cutFitsBlob(shared)
                    ? "calibration.knife.cutNote"
                    : "calibration.knife.middleNote",
                )}
          </span>
        </div>
      )}

      {decided && (
        <button
          type="button"
          className="cursor-pointer self-start text-[12.5px] font-semibold text-lapis-text hover:underline disabled:cursor-default disabled:text-ink-4"
          disabled={disabled}
          onClick={onRelease}
        >
          {t("calibration.release")}
        </button>
      )}
    </div>
  );
}

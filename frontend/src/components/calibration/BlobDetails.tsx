import { useState } from "react";
import { useTranslation } from "react-i18next";

import { mediaUrl } from "@/lib/api";
import type {
  Allocation,
  BlobException,
  CalibrationBlob,
  CalibrationLine,
} from "@/lib/calibration/types";

const EXCEPTIONS: BlobException[] = ["", "mixed", "broken", "fused", "uncertain"];

const selectClass =
  "h-[34px] min-w-0 flex-1 cursor-pointer rounded-control border border-rule-2 bg-card px-2 text-[13px] text-ink outline-none focus:border-lapis disabled:cursor-default disabled:opacity-50";
/** A small outlined button beside a select. */
const ACTION =
  "h-[34px] flex-none cursor-pointer rounded-control border border-rule-2 bg-card px-3 text-[12.5px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:text-ink-4";
/** A PAW count's input. */
const PAWS_INPUT =
  "h-[34px] w-14 flex-none rounded-control border border-rule-2 bg-card px-2 font-mono text-[13px] text-ink outline-none focus:border-lapis";

/** One blob's own pixels, cut from its line's image at a readable size. */
export function BlobCrop({
  url,
  x,
  y,
  w,
  h,
  box = 72,
}: {
  url: string;
  /** The blob's box in the image's own pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  box?: number;
}) {
  const pad = 4;
  const cw = w + pad * 2;
  const ch = h + pad * 2;
  const k = Math.min(box / cw, box / ch, 4);
  return (
    <div
      className="relative flex-none overflow-hidden rounded-sm border border-rule bg-white"
      style={{ width: cw * k, height: ch * k }}
    >
      <img
        src={mediaUrl(url)}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
        style={{
          transform: `translate(${-(x - pad) * k}px, ${-(y - pad) * k}px) scale(${k})`,
          transformOrigin: "0 0",
          imageRendering: k > 1.6 ? "pixelated" : undefined,
        }}
      />
    </div>
  );
}

/**
 * Which word the selected ink belongs to, and the rarer decisions about it: give it
 * to a word with a PAW count, share one body across a word break, leave marks
 * unattached, flag ink out of the ordinary, take decisions back. Recording
 * ownership changes nobody's role.
 */
export function OwnershipControls({
  line,
  blobs,
  disabled,
  onException,
  onAssign,
  onShare,
  onRelease,
  onUnassign,
}: {
  line: CalibrationLine;
  blobs: CalibrationBlob[];
  disabled: boolean;
  onException: (exception: BlobException) => void;
  onAssign: (wordId: number, paws: number) => void;
  onShare: (shares: Allocation[]) => void;
  onRelease: () => void;
  onUnassign: () => void;
}) {
  const { t } = useTranslation();
  const single = blobs.length === 1 ? blobs[0] : null;
  const labelled = line.words.filter((word) => word.word_id !== null);
  const [target, setTarget] = useState<number | "">("");
  const [paws, setPaws] = useState(1);
  const [partner, setPartner] = useState<number | "">("");
  const decided = blobs.some((blob) => blob.explicit || blob.ownership_explicit);
  const bodies = blobs.some((blob) => blob.role === "body");
  const marks = blobs.filter((blob) => blob.role === "mark");
  const exception =
    new Set(blobs.map((blob) => blob.exception)).size === 1 ? blobs[0].exception : "";
  const wordText = (id: number) => line.words.find((word) => word.word_id === id)?.text ?? `#${id}`;
  const owner = single?.allocations.length === 1 ? single.allocations[0].word_id : null;
  const at = labelled.findIndex((word) => word.word_id === owner);
  const neighbours =
    at < 0
      ? []
      : labelled.filter(
          (word, index) => Math.abs(index - at) === 1 && word.aya === labelled[at].aya,
        );

  return (
    <div className="flex flex-col gap-2 text-[12.5px] text-ink-2">
      <div className="flex items-center gap-2">
        <select
          className={selectClass}
          value={target}
          disabled={disabled || !labelled.length}
          aria-label={t("calibration.assignTitle")}
          onChange={(event) => setTarget(event.target.value ? Number(event.target.value) : "")}
        >
          <option value="">{t("calibration.chooseWord")}</option>
          {labelled.map((word) => (
            <option key={word.word_id} value={word.word_id!}>
              {word.text} · {word.aya}
            </option>
          ))}
        </select>
        {bodies && (
          <input
            type="number"
            min={0}
            max={8}
            value={paws}
            disabled={disabled}
            onChange={(event) => setPaws(Math.max(0, Math.min(8, Number(event.target.value) || 0)))}
            className={PAWS_INPUT}
            title={t("calibration.pawsHelp")}
            aria-label={t("calibration.paws")}
          />
        )}
        <button
          type="button"
          className={ACTION}
          disabled={disabled || target === ""}
          onClick={() => target !== "" && onAssign(target, bodies ? paws : 0)}
        >
          {t("calibration.assign")}
        </button>
      </div>

      {single && single.role === "body" && single.allocations.length === 1 && (
        <div className="flex items-center gap-2" title={t("calibration.shareHelp")}>
          <select
            className={selectClass}
            value={partner}
            disabled={disabled || !neighbours.length}
            aria-label={t("calibration.shareWith")}
            onChange={(event) => setPartner(event.target.value ? Number(event.target.value) : "")}
          >
            <option value="">{t("calibration.shareWith")}</option>
            {neighbours.map((word) => (
              <option key={word.word_id} value={word.word_id!}>
                {word.text} · {word.aya}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={ACTION}
            disabled={disabled || partner === ""}
            onClick={() =>
              partner !== "" &&
              onShare([{ ...single.allocations[0] }, { word_id: partner, paws: 1 }])
            }
          >
            {t("calibration.share")}
          </button>
        </div>
      )}

      {single && single.role === "body" && single.allocations.length > 1 && (
        <div className="flex flex-col gap-1">
          {single.allocations.map((share) => (
            <label key={share.word_id} className="flex items-center justify-between gap-2">
              <span dir="rtl" className="min-w-0 truncate font-quran text-[17px] text-ink">
                {wordText(share.word_id)}
              </span>
              <input
                type="number"
                min={0}
                max={8}
                step={1}
                value={share.paws}
                disabled={disabled}
                aria-label={`${wordText(share.word_id)}: ${t("calibration.paws")}`}
                className={PAWS_INPUT}
                onChange={(event) =>
                  onShare(
                    single.allocations.map((allocation) =>
                      allocation.word_id === share.word_id
                        ? {
                            ...allocation,
                            paws: Math.max(
                              0,
                              Math.min(8, Math.round(Number(event.target.value) || 0)),
                            ),
                          }
                        : allocation,
                    ),
                  )
                }
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <select
          className={selectClass}
          value={exception}
          disabled={disabled}
          aria-label={t("calibration.exception")}
          title={t("calibration.exception")}
          onChange={(event) => onException(event.target.value as BlobException)}
        >
          {EXCEPTIONS.map((value) => (
            <option key={value || "none"} value={value}>
              {t(`calibration.exceptionKind.${value || "none"}`)}
            </option>
          ))}
        </select>
        {marks.length > 0 && (
          <button type="button" className={ACTION} disabled={disabled} onClick={onUnassign}>
            {t("calibration.unassignMarks", { count: marks.length })}
          </button>
        )}
      </div>

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

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PanelCard } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { mediaUrl, useCalibrationExamples } from "@/lib/api";
import type {
  Allocation,
  BlobException,
  CalibrationBlob,
  CalibrationLine,
} from "@/lib/calibration/types";

import { reasonKey, subtypeKey } from "./labels";

const EXCEPTIONS: BlobException[] = ["", "mixed", "broken", "fused", "uncertain"];

const selectClass =
  "h-8 w-full cursor-pointer rounded border border-border-strong bg-white px-2 text-[12px] text-text-primary outline-none focus:border-orange disabled:cursor-default disabled:opacity-50";

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
      className="relative flex-none overflow-hidden rounded-sm border border-border bg-white"
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
 * The rarer decisions on the selected blobs — the common ones, and everything the
 * selection is, are in the bar under the lines (`SelectionBar`).
 *
 * Which word the ink belongs to and with how many PAWs, sharing a body across a word
 * break, flagging ink out of the ordinary, taking decisions back — and, asked for on
 * demand, the confirmed examples nearest one blob, which say why calibration would
 * read it as a body or a mark.
 */
export function BlobInspector({
  mushafId,
  page,
  line,
  blobs,
  disabled,
  onException,
  onAssign,
  onShare,
  onRelease,
  onUnassign,
}: {
  mushafId: string;
  page: number;
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

  return (
    <PanelCard
      title={
        single
          ? t("calibration.inspectorOne", { id: single.id, line: line.line_number })
          : t("calibration.inspectorMany", { count: blobs.length, line: line.line_number })
      }
    >
      {single && (
        <p className="-mt-1 text-[11px] text-text-muted">
          {t("calibration.evidence")}: {t(`calibration.role.${single.initial_role}`)} ·{" "}
          {single.body_score}/14
        </p>
      )}

      <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
        {t("calibration.exception")}
        <select
          className={selectClass}
          value={exception}
          disabled={disabled}
          onChange={(event) => onException(event.target.value as BlobException)}
        >
          {EXCEPTIONS.map((value) => (
            <option key={value || "none"} value={value}>
              {t(`calibration.exceptionKind.${value || "none"}`)}
            </option>
          ))}
        </select>
      </label>

      {/* Ownership: which word this ink is. Records it; changes nobody's role. */}
      <div className="flex flex-col gap-1.5 text-[11px] text-text-secondary">
        {t("calibration.assignTitle")}
        {marks.length > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-8 self-start text-[12px]"
            disabled={disabled}
            onClick={onUnassign}
          >
            {t("calibration.unassignMarks", { count: marks.length })}
          </Button>
        )}
        <div className="flex items-center gap-1.5">
          <select
            className={selectClass}
            value={target}
            disabled={disabled || !labelled.length}
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
              onChange={(event) =>
                setPaws(Math.max(0, Math.min(8, Number(event.target.value) || 0)))
              }
              className="h-8 w-14 rounded border border-border-strong px-2 text-[12px] tabular-nums outline-none focus:border-orange"
              title={t("calibration.pawsHelp")}
              aria-label={t("calibration.paws")}
            />
          )}
          <Button
            type="button"
            variant="outline"
            className="h-8 px-2.5 text-[12px]"
            disabled={disabled || target === ""}
            onClick={() => target !== "" && onAssign(target, bodies ? paws : 0)}
          >
            {t("calibration.assign")}
          </Button>
        </div>
        {single && single.role === "body" && single.allocations.length === 1 && (
          <div className="flex items-center gap-1.5" title={t("calibration.shareHelp")}>
            <select
              className={selectClass}
              value={partner}
              disabled={disabled}
              onChange={(event) => setPartner(event.target.value ? Number(event.target.value) : "")}
            >
              <option value="">{t("calibration.shareWith")}</option>
              {labelled
                .filter((word, index) => {
                  const owner = labelled.findIndex(
                    (candidate) => candidate.word_id === single.allocations[0].word_id,
                  );
                  return Math.abs(index - owner) === 1 && word.aya === labelled[owner]?.aya;
                })
                .map((word) => (
                  <option key={word.word_id} value={word.word_id!}>
                    {word.text} · {word.aya}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              variant="outline"
              className="h-8 px-2.5 text-[12px]"
              disabled={disabled || partner === ""}
              onClick={() =>
                partner !== "" &&
                onShare([{ ...single.allocations[0] }, { word_id: partner, paws: 1 }])
              }
            >
              {t("calibration.share")}
            </Button>
          </div>
        )}
        {single && single.role === "body" && single.allocations.length > 1 && (
          <div className="flex flex-col gap-1.5">
            {single.allocations.map((share) => (
              <label key={share.word_id} className="flex items-center justify-between gap-2">
                <span dir="rtl" className="min-w-0 break-words">
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
                  className="h-8 w-14 flex-none rounded border border-border-strong px-2 text-[12px] tabular-nums"
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
      </div>

      {decided && (
        <Button
          type="button"
          variant="ghost"
          className="h-7 self-start px-2 text-[11px] text-text-secondary"
          disabled={disabled}
          onClick={onRelease}
        >
          {t("calibration.release")}
        </Button>
      )}

      {single && <Examples mushafId={mushafId} page={page} line={line} blob={single} />}
    </PanelCard>
  );
}

/** The confirmed examples nearest one blob, and what calibration makes of them. */
function Examples({
  mushafId,
  page,
  line,
  blob,
}: {
  mushafId: string;
  page: number;
  line: CalibrationLine;
  blob: CalibrationBlob;
}) {
  const { t } = useTranslation();
  const text = blob.role === "body" || blob.role === "mark";
  const subtype = (value: string) => {
    const key = subtypeKey(value);
    return key ? t(key) : value;
  };
  const { data, isLoading } = useCalibrationExamples(
    mushafId,
    page,
    text ? line.snapshot_id : null,
    text ? blob.id : null,
  );
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2">
      <div className="text-[11px] font-semibold text-text-secondary">
        {t("calibration.examplesTitle")}
      </div>
      <p className="text-[10.5px] leading-snug text-text-muted">
        {blob.proposed_role
          ? t("calibration.proposes", { role: t(`calibration.role.${blob.proposed_role}`) })
          : t("calibration.noProposal", {
              reasons: (blob.proposal.reasons?.length
                ? blob.proposal.reasons
                : (data?.reasons ?? ["no_examples"])
              )
                .map((reason) => {
                  const key = reasonKey(reason);
                  return key ? t(key) : reason;
                })
                .join(", "),
            })}
      </p>
      {isLoading && (
        <span className="text-[10.5px] text-text-muted">{t("calibration.loadingExamples")}</span>
      )}
      {data && !data.neighbors.length && (
        <span className="text-[10.5px] text-text-muted">{t("calibration.noExamples")}</span>
      )}
      {data?.neighbors.map((example) => (
        <div
          key={`${example.snapshot_id}:${example.blob_id}`}
          className="flex items-center gap-2 text-[10.5px] text-text-secondary"
        >
          {example.image_url && example.crop && (
            <BlobCrop url={example.image_url} {...example.crop} box={40} />
          )}
          <span className="flex-1">
            <span className="font-semibold">{t(`calibration.role.${example.role}`)}</span>
            {example.subtype ? ` · ${subtype(example.subtype)}` : ""}
            <br />
            <Link
              to="/mushafs/$mushafId/word-cuts"
              params={{ mushafId }}
              search={{ page: example.page_number, mode: "calibrate" }}
              className="underline underline-offset-2 hover:text-orange"
            >
              {t("calibration.exampleFrom", {
                page: example.page_number,
                line: example.line_number,
              })}
            </Link>
            {example.copies > 1 ? ` · ×${example.copies}` : ""}
          </span>
          <span className="tabular-nums text-text-muted">{example.distance.toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

import { Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DIALOG_PRIMARY, DIALOG_SECONDARY, SatrDialog } from "@/components/app/SatrDialog";
import type { ProcessSettings, Rect } from "@/lib/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  rangeStart: number;
  rangeEnd: number;
  /** Pre-formatted "N. الفاتحة — Al-Fatiha" label for the start sura. */
  startSuraLabel: string;
  startAya: number;
  bounds: Rect;
  settings: ProcessSettings;
  /** The page on the canvas and its natural size, for the thumbnail with the
   * bounds drawn on it. */
  imageUrl?: string;
  natural?: { w: number; h: number } | null;
  /** Show the first-run advisory here too — this is the point of no return. */
  firstRun?: boolean;
  /** Range still covers page 1 or 2, which line detection can't read. */
  earlyPages?: boolean;
};

/** Last gate before a processing run: repeats everything that is about to be
 * sent, because the run is expensive and overwrites the range's coordinates. */
export function ProcessConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  rangeStart,
  rangeEnd,
  startSuraLabel,
  startAya,
  bounds,
  settings,
  imageUrl,
  natural,
  firstRun,
  earlyPages,
}: Props) {
  const { t } = useTranslation();
  const count = rangeEnd - rangeStart + 1;
  const onOff = (v: boolean) => (v ? t("process.on") : t("process.off"));
  const chips: [string, string | number][] = [
    [t("process.linesPerPage"), settings.expected_lines],
    [t("process.headerThreshold"), settings.sura_header_threshold],
    [t("process.headerSlots"), settings.sura_header_slots],
    [t("process.maxHeaders"), settings.max_sura_headers],
    [t("process.ayaThreshold"), settings.match_threshold],
    [t("process.padding"), settings.padding],
    [t("process.altMargins"), onOff(settings.alternate_horizontal_margin)],
    [t("process.preferAccel"), onOff(settings.prefer_acceleration)],
  ];

  return (
    <SatrDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("process.confirmTitle")}
      description={t("process.confirmIntro")}
      width={620}
      footer={
        <>
          <button type="button" onClick={() => onOpenChange(false)} className={DIALOG_SECONDARY}>
            {t("common.cancel")}
          </button>
          <button type="button" onClick={onConfirm} className={DIALOG_PRIMARY}>
            {t("process.confirmSubmit")}
          </button>
        </>
      }
    >
      <div className="flex items-stretch gap-[18px]">
        {imageUrl && natural && (
          // The page on white, as scanned, with the bounds dashed over it.
          <div className="relative w-24 flex-none self-center bg-white shadow-[0_4px_12px_rgba(0,0,0,0.18)]">
            <img src={imageUrl} alt="" className="block h-auto w-full" draggable={false} />
            <span
              aria-hidden="true"
              className="absolute border-[1.5px] border-dashed border-ov-bounds"
              style={{
                left: `${(bounds.x / natural.w) * 100}%`,
                top: `${(bounds.y / natural.h) * 100}%`,
                width: `${(bounds.w / natural.w) * 100}%`,
                height: `${(bounds.h / natural.h) * 100}%`,
              }}
            />
          </div>
        )}
        <dl className="m-0 grid flex-1 grid-cols-[110px_1fr] content-center gap-x-3.5 gap-y-2.5 text-[14px]">
          <dt className="text-ink-3">{t("process.confirmPages")}</dt>
          <dd className="m-0">
            {t("process.confirmPagesValue", { start: rangeStart, end: rangeEnd, count })}
          </dd>
          <dt className="text-ink-3">{t("process.confirmStartAt")}</dt>
          <dd className="m-0">
            {t("process.confirmStartAtValue", { sura: startSuraLabel, aya: startAya })}
          </dd>
          <dt className="text-ink-3">{t("process.confirmBounds")}</dt>
          <dd dir="ltr" className="m-0 justify-self-start font-mono text-[13px]">
            {`${Math.round(bounds.x)}, ${Math.round(bounds.y)} · ${Math.round(bounds.w)} × ${Math.round(bounds.h)}`}
          </dd>
        </dl>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {t("process.confirmSettings")}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {chips.map(([label, value]) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5 rounded-control bg-sunk px-2.5 py-[5px] text-[12.5px] text-ink-2"
            >
              <span>{label}</span>
              <strong className="font-mono">{value}</strong>
            </span>
          ))}
        </div>
      </div>

      <p className="m-0 flex items-start gap-2.5 rounded-lg bg-lapis-wash px-3.5 py-[11px] text-[13.5px] leading-normal text-lapis-text">
        <Info size={15} className="mt-0.5 flex-none" aria-hidden="true" />
        <span>{t("process.confirmCancellable")}</span>
      </p>

      {earlyPages && (
        <Callout title={t("process.earlyPagesTitle")} body={t("process.earlyPagesBody")} />
      )}
      {firstRun && (
        <Callout title={t("process.firstRunTitle")} body={t("process.firstRunBody", { count })} />
      )}
    </SatrDialog>
  );
}

function Callout({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-2.5 rounded-lg bg-warn-wash px-3.5 py-[11px] text-[13px] leading-normal text-warn-text">
      <TriangleAlert size={15} className="mt-0.5 flex-none" aria-hidden="true" />
      <span>
        <span className="font-semibold">{title}</span>
        <br />
        {body}
      </span>
    </div>
  );
}

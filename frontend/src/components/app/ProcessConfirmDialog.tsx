import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  /** Pages per request, so the user knows the run is split up. */
  chunkSize: number;
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
  chunkSize,
  firstRun,
  earlyPages,
}: Props) {
  const { t } = useTranslation();
  const count = rangeEnd - rangeStart + 1;
  const batches = Math.max(1, Math.ceil(count / chunkSize));
  const onOff = (v: boolean) => (v ? t("process.on") : t("process.off"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("process.confirmTitle")}</DialogTitle>
          <DialogDescription>{t("process.confirmIntro")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-1">
          <SummaryRow
            label={t("process.confirmPages")}
            value={t("process.confirmPagesValue", { start: rangeStart, end: rangeEnd, count })}
          />
          <SummaryRow
            label={t("process.confirmStartAt")}
            value={t("process.confirmStartAtValue", { sura: startSuraLabel, aya: startAya })}
          />
          <SummaryRow
            label={t("process.confirmBounds")}
            value={`${Math.round(bounds.w)}×${Math.round(bounds.h)} @ ${Math.round(bounds.x)},${Math.round(bounds.y)}`}
          />

          <div className="rounded-md border border-border bg-bg-surface p-3">
            <div className="mb-2 text-[11.5px] font-semibold tracking-[0.03em] text-text-secondary">
              {t("process.confirmSettings")}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
              <Setting label={t("process.linesPerPage")} value={settings.expected_lines} />
              <Setting label={t("process.padding")} value={settings.padding} />
              <Setting label={t("process.headerSlots")} value={settings.sura_header_slots} />
              <Setting label={t("process.maxHeaders")} value={settings.max_sura_headers} />
              <Setting
                label={t("process.headerThreshold")}
                value={settings.sura_header_threshold}
              />
              <Setting label={t("process.ayaThreshold")} value={settings.match_threshold} />
              <Setting
                label={t("process.altMargins")}
                value={onOff(settings.alternate_horizontal_margin)}
              />
              <Setting
                label={t("process.preferAccel")}
                value={onOff(settings.prefer_acceleration)}
              />
            </dl>
          </div>

          <p className="text-[11.5px] text-text-muted">
            {t("process.confirmBatches", { count: batches, size: chunkSize })}
          </p>

          {earlyPages && (
            <Callout title={t("process.earlyPagesTitle")} body={t("process.earlyPagesBody")} />
          )}
          {firstRun && (
            <Callout
              title={t("process.firstRunTitle")}
              body={t("process.firstRunBody", { count })}
            />
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t("process.confirmSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Callout({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-2 rounded-md border border-[color:var(--warning-border)] bg-warning-bg px-3 py-2.5 text-[12px] leading-[1.55] text-[#92400E]">
      <TriangleAlert size={15} className="mt-[1px] flex-shrink-0" />
      <span>
        <span className="font-semibold">{title}</span>
        <br />
        {body}
      </span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 text-[12.5px]">
      <span className="text-text-secondary">{label}</span>
      <span className="font-mono text-text-primary">{value}</span>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="truncate text-text-secondary">{label}</dt>
      <dd className="font-mono text-text-primary">{value}</dd>
    </div>
  );
}

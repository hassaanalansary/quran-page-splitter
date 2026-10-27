import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";

import { DIALOG_SECONDARY, SatrDialogFrame } from "@/components/app/SatrDialog";
import { Switch } from "@/components/ui/switch";
import { calibrationKeys, setCalibrationSettings } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CalibrationSettings } from "@/lib/calibration/types";

/** A small outlined button beside the LIMIT field. */
const SMALL =
  "h-8 cursor-pointer rounded-control border border-rule-2 bg-card px-2.5 text-[12.5px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-50";

/** The fingerprint library's LIMIT is refused above this — the server's `LIMIT_CEILING`. */
const LIMIT_CEILING = 10;

export function LearningSettings({
  mushafId,
  page,
  settings,
  disabled,
}: {
  mushafId: string;
  page: number;
  settings: CalibrationSettings;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [limitDraft, setLimitDraft] = useState(String(settings.limit));
  // A LIMIT equal to the default is saved as "the default", so it follows the default.
  const savedLimit = settings.limit === settings.default_limit ? null : settings.limit;
  const mutation = useMutation({
    mutationFn: (change: { experimental: boolean; limit: number | null }) =>
      setCalibrationSettings(mushafId, settings.revision, change),
    onSuccess: (saved) => {
      setOpen(false);
      setLimitDraft(String(saved.limit));
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
    },
  });
  const typed = Number(limitDraft);
  const limitValid =
    limitDraft.trim() !== "" && Number.isFinite(typed) && typed > 0 && typed <= LIMIT_CEILING;
  const limitChanged = limitValid && typed !== settings.limit;
  const busy = disabled || mutation.isPending;
  return (
    <>
      <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
        {t("calibration.experimentalSwitch")}
        <Switch
          checked={settings.experimental}
          disabled={busy}
          onCheckedChange={(enabled) =>
            enabled ? setOpen(true) : mutation.mutate({ experimental: false, limit: savedLimit })
          }
        />
      </label>
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
          {t("calibration.libraryLimit")}
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="decimal"
              step={0.01}
              min={0.01}
              max={LIMIT_CEILING}
              value={limitDraft}
              disabled={busy}
              aria-invalid={!limitValid}
              onChange={(event) => setLimitDraft(event.target.value)}
              className="h-8 w-20 rounded-control border border-rule-2 bg-card px-2 font-mono text-[13px] text-ink outline-none focus:border-lapis aria-[invalid=true]:border-stop disabled:opacity-50"
            />
            <button
              type="button"
              className={SMALL}
              disabled={busy || !limitChanged}
              onClick={() =>
                mutation.mutate({
                  experimental: settings.experimental,
                  limit: typed === settings.default_limit ? null : typed,
                })
              }
            >
              {t("calibration.applyLimit")}
            </button>
            <button
              type="button"
              className={`${SMALL} border-transparent bg-transparent text-ink-2`}
              disabled={busy || savedLimit === null}
              onClick={() => mutation.mutate({ experimental: settings.experimental, limit: null })}
            >
              {t("calibration.defaultLimit")}
            </button>
          </span>
        </label>
        <p className="m-0 text-[12px] leading-snug text-ink-3">
          {t("calibration.libraryLimitHelp", { value: settings.default_limit })}
        </p>
      </div>
      <SatrDialogFrame
        open={open}
        onOpenChange={(next) => !mutation.isPending && setOpen(next)}
        width={480}
      >
        <div className="flex flex-col gap-2.5 px-[22px] py-[18px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <DialogPrimitive.Title className="m-0 font-display text-[21px] font-semibold leading-tight">
              {t("calibration.experimentalTitle")}
            </DialogPrimitive.Title>
            <span className="rounded-pill bg-gold-wash px-2 py-px text-[11.5px] font-semibold text-gold-text">
              {t("calibration.experimentalBadge")}
            </span>
          </div>
          <DialogPrimitive.Description className="m-0 text-[13.5px] leading-[1.55] text-ink-2">
            {t("calibration.experimentalWarning")}
          </DialogPrimitive.Description>
        </div>
        <div className="flex flex-wrap justify-end gap-2 bg-sheet px-[22px] py-3">
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => setOpen(false)}
            className={cn(DIALOG_SECONDARY, "h-10 px-4 text-[13.5px]")}
          >
            {t("calibration.notNow")}
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ experimental: true, limit: savedLimit })}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-control bg-gold px-4 text-[13.5px] font-bold text-on-gold transition-[filter] hover:brightness-105 disabled:cursor-default disabled:opacity-60"
          >
            {t("calibration.enableExperimental")}
          </button>
        </div>
      </SatrDialogFrame>
    </>
  );
}

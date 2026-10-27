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

/** The page's learning switch. The library's LIMIT is set in the Library mode, where
 * what it changes can be previewed. */
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
  // A LIMIT equal to the default is saved as "the default", so it follows the default.
  const savedLimit = settings.limit === settings.default_limit ? null : settings.limit;
  const mutation = useMutation({
    mutationFn: (change: { experimental: boolean; limit: number | null }) =>
      setCalibrationSettings(mushafId, settings.revision, change),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
    },
  });
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

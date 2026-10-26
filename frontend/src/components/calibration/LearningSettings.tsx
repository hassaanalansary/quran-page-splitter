import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { calibrationKeys, setCalibrationSettings } from "@/lib/api";
import type { CalibrationSettings } from "@/lib/calibration/types";

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
      <label className="flex items-center justify-between gap-3 text-[12px] text-text-primary">
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
        <label className="flex items-center justify-between gap-3 text-[12px] text-text-primary">
          {t("calibration.libraryLimit")}
          <span className="flex items-center gap-1.5">
            <Input
              type="number"
              inputMode="decimal"
              step={0.01}
              min={0.01}
              max={LIMIT_CEILING}
              value={limitDraft}
              disabled={busy}
              aria-invalid={!limitValid}
              onChange={(event) => setLimitDraft(event.target.value)}
              className="h-7 w-20 px-2 text-[12px] tabular-nums"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11.5px]"
              disabled={busy || !limitChanged}
              onClick={() =>
                mutation.mutate({
                  experimental: settings.experimental,
                  limit: typed === settings.default_limit ? null : typed,
                })
              }
            >
              {t("calibration.applyLimit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11.5px]"
              disabled={busy || savedLimit === null}
              onClick={() => mutation.mutate({ experimental: settings.experimental, limit: null })}
            >
              {t("calibration.defaultLimit")}
            </Button>
          </span>
        </label>
        <p className="text-[10.5px] leading-snug text-text-muted">
          {t("calibration.libraryLimitHelp", { value: settings.default_limit })}
        </p>
      </div>
      <Dialog open={open} onOpenChange={(next) => !mutation.isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("calibration.experimentalTitle")}</DialogTitle>
            <DialogDescription>{t("calibration.experimentalWarning")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setOpen(false)}>
              {t("calibration.discardPreview")}
            </Button>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ experimental: true, limit: savedLimit })}
            >
              {t("calibration.enableExperimental")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

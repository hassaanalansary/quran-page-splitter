import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

export function LearningSettings({
  mushafId,
  page,
  settings,
  disabled,
}: {
  mushafId: string;
  page: number;
  settings: { revision: number; experimental: boolean };
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setCalibrationSettings(mushafId, settings.revision, enabled),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
    },
  });
  return (
    <>
      <label className="flex items-center justify-between gap-3 text-[12px] text-text-primary">
        {t("calibration.experimentalSwitch")}
        <Switch
          checked={settings.experimental}
          disabled={disabled || mutation.isPending}
          onCheckedChange={(enabled) => (enabled ? setOpen(true) : mutation.mutate(false))}
        />
      </label>
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
            <Button disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
              {t("calibration.enableExperimental")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

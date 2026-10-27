import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BusyLabel } from "@/components/app/SatrLoader";
import { DIALOG_SECONDARY, SatrConfirmDialog } from "@/components/app/SatrDialog";
import { ApiError, deleteMushaf, queryKeys } from "@/lib/api";

/** Deleting a mushaf, from the shelf or its settings. The name has to be typed
 * back before the button wakes: this cannot be undone. */
export function DeleteMushafDialog({
  mushaf,
  open,
  onOpenChange,
  onDeleted,
}: {
  mushaf: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the delete lands, e.g. to leave a page that no longer exists. */
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const remove = useMutation({
    mutationFn: () => deleteMushaf(mushaf.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("home.deleted", { name: mushaf.name }));
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("home.deleteFailed")),
  });

  const confirmed = typed.trim() === mushaf.name.trim();

  return (
    <SatrConfirmDialog
      open={open}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
      icon={<Trash2 className="h-[18px] w-[18px]" aria-hidden="true" />}
      title={t("deleteDialog.title", { name: mushaf.name })}
      body={t("deleteDialog.body")}
      actions={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={remove.isPending}
            className={`${DIALOG_SECONDARY} h-10 px-4 text-[13.5px]`}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={!confirmed || remove.isPending}
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-control bg-stop px-4 text-[13.5px] font-semibold text-on-stop transition-colors hover:bg-stop/90 disabled:cursor-default disabled:opacity-50"
          >
            {remove.isPending ? (
              <BusyLabel>{t("deleteDialog.deleting")}</BusyLabel>
            ) : (
              t("deleteDialog.confirm")
            )}
          </button>
        </>
      }
    >
      <label className="mt-1 flex flex-col gap-1">
        <span className="text-[12.5px] text-ink-2">{t("deleteDialog.typeLabel")}</span>
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && confirmed && !remove.isPending) remove.mutate();
          }}
          autoComplete="off"
          dir="auto"
          className="h-9 rounded-control border border-rule-2 bg-card px-2.5 text-[14px] text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)]"
        />
      </label>
    </SatrConfirmDialog>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BusyLabel } from "@/components/app/SatrLoader";
import {
  DIALOG_INPUT,
  DIALOG_PRIMARY,
  DIALOG_SECONDARY,
  DialogField,
  FileCard,
  SatrDialog,
} from "@/components/app/SatrDialog";
import { ApiError, createMushaf, DEFAULT_QIRAA, queryKeys, useQiraat } from "@/lib/api";

export function CreateMushafDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: qiraat } = useQiraat();
  const [name, setName] = useState("");
  const [qiraa, setQiraa] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Default to Hafs (or the first available) until the user picks another. Keyed
  // by the qiraa's real DB `name` — the value create/PATCH match on exactly.
  const defaultQiraa = useMemo(() => {
    if (!qiraat || qiraat.length === 0) return "";
    const preferred = qiraat.find((q) => q.name.toLowerCase() === DEFAULT_QIRAA);
    return (preferred ?? qiraat[0]).name;
  }, [qiraat]);
  const selectedQiraa = qiraa || defaultQiraa;

  useEffect(() => {
    if (!open) {
      setName("");
      setQiraa("");
      setFile(null);
      setError(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => createMushaf({ pdf: file!, name: name.trim(), qiraa: selectedQiraa }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      if (result.warnings.duplicate_file) {
        toast.warning(t("createDialog.duplicateWarning"));
      }
      toast.success(t("createDialog.created", { name: result.mushaf.name }));
      onOpenChange(false);
      navigate({ to: "/mushafs/$mushafId/setup", params: { mushafId: result.mushaf.id } });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("createDialog.createFailed")),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError(t("createDialog.nameRequired"));
    if (!file) return setError(t("createDialog.fileRequired"));
    mutation.mutate();
  }

  return (
    <SatrDialog
      open={open}
      onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}
      title={t("createDialog.title")}
      description={t("createDialog.description")}
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
            className={DIALOG_SECONDARY}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="create-mushaf"
            disabled={mutation.isPending}
            className={DIALOG_PRIMARY}
          >
            {mutation.isPending ? (
              <BusyLabel>{t("createDialog.creating")}</BusyLabel>
            ) : (
              t("createDialog.create")
            )}
          </button>
        </>
      }
    >
      <form id="create-mushaf" onSubmit={onSubmit} className="flex flex-col gap-[18px]">
        <DialogField
          label={t("createDialog.nameLabel")}
          htmlFor="mushaf-name"
          hint={t("createDialog.nameHint")}
        >
          <input
            id="mushaf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("createDialog.namePlaceholder")}
            dir="auto"
            autoFocus
            className={DIALOG_INPUT}
          />
        </DialogField>

        <DialogField
          label={t("createDialog.qiraaLabel")}
          htmlFor="mushaf-qiraa"
          hint={t("createDialog.qiraaHint")}
        >
          <select
            id="mushaf-qiraa"
            value={selectedQiraa}
            onChange={(e) => setQiraa(e.target.value)}
            disabled={!qiraat || qiraat.length === 0}
            className={`${DIALOG_INPUT} cursor-pointer px-3 capitalize`}
          >
            {!qiraat ? (
              <option value="">{t("createDialog.qiraaLoading")}</option>
            ) : qiraat.length === 0 ? (
              <option value="">{t("createDialog.qiraaNone")}</option>
            ) : (
              qiraat.map((q) => (
                <option key={q.name} value={q.name}>
                  {q.name} — {q.counting_system}
                </option>
              ))
            )}
          </select>
        </DialogField>

        <DialogField label={t("createDialog.pdfLabel")}>
          <input
            ref={picker}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          {file ? (
            <FileCard
              badge="PDF"
              tone="stop"
              name={file.name}
              detail={t("createDialog.fileMb", { size: (file.size / 1024 / 1024).toFixed(1) })}
              action={
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  className="h-9 flex-none cursor-pointer rounded-control border border-rule-2 bg-card px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-sheet"
                >
                  {t("createDialog.replace")}
                </button>
              }
            />
          ) : (
            <button
              type="button"
              onClick={() => picker.current?.click()}
              className="flex h-[76px] cursor-pointer items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-rule-2 bg-sheet text-[14px] font-semibold text-ink-2 transition-colors hover:border-lapis hover:text-lapis-text"
            >
              <FileUp className="h-[18px] w-[18px]" aria-hidden="true" />
              {t("createDialog.choosePdf")}
            </button>
          )}
        </DialogField>

        {error && (
          <div className="rounded-lg border border-stop/20 bg-stop-wash px-3.5 py-2.5 text-[13.5px] text-stop-text">
            {error}
          </div>
        )}
      </form>
    </SatrDialog>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { PublishPanel } from "@/components/app/details/PublishPanel";
import {
  ApiError,
  deleteMushaf,
  queryKeys,
  regenerateThumbnail,
  updateMushaf,
  useQiraat,
  type MushafDetail,
  type MushafPatch,
} from "@/lib/api";

export function SettingsTab({ mushaf }: { mushaf: MushafDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: qiraat } = useQiraat();

  const [name, setName] = useState(mushaf.name);
  const [qiraa, setQiraa] = useState(mushaf.qiraa ?? "");
  const [first, setFirst] = useState(mushaf.first_quran_pdf_page);
  const [last, setLast] = useState(mushaf.last_quran_pdf_page);
  const [error, setError] = useState<string | null>(null);

  const locked = mushaf.processed_page_count > 0;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushaf.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushaf.id) });
  }

  const save = useMutation({
    mutationFn: (patch: MushafPatch) => updateMushaf(mushaf.id, patch),
    onSuccess: () => {
      invalidate();
      setError(null);
      toast.success(t("details.set_updated"));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("details.set_updateFailed")),
  });

  const regenerate = useMutation({
    mutationFn: () => regenerateThumbnail(mushaf.id),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.mushaf(mushaf.id), detail);
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("details.set_thumbRegenerated"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("details.set_regenFailed")),
  });

  const remove = useMutation({
    mutationFn: () => deleteMushaf(mushaf.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("details.set_deleted", { name: mushaf.name }));
      navigate({ to: "/" });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("details.set_deleteFailed")),
  });

  function onSaveMushaf() {
    const patch: MushafPatch = {};
    if (name.trim() !== mushaf.name) patch.name = name.trim();
    if ((qiraa || null) !== mushaf.qiraa) patch.qiraa = qiraa || null;
    if (Object.keys(patch).length === 0) return toast.info(t("details.set_nothingToSave"));
    save.mutate(patch);
  }

  function onSaveBounds() {
    const patch: MushafPatch = {};
    if (first !== mushaf.first_quran_pdf_page) patch.first_quran_pdf_page = first;
    if (last !== mushaf.last_quran_pdf_page) patch.last_quran_pdf_page = last;
    if (Object.keys(patch).length === 0) return toast.info(t("details.set_nothingToSave"));
    save.mutate(patch);
  }

  const inputClass =
    "h-[34px] w-full rounded-lg border-[1.5px] border-border-strong bg-white px-[11px] text-[12.5px] font-medium text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]";

  return (
    <div>
      <div className="grid grid-cols-2 gap-3.5">
        {/* Mushaf card */}
        <div className="rounded-[11px] border border-border bg-white p-4">
          <div className="mb-3.5 text-[12.5px] font-bold text-text-primary">
            {t("details.set_mushaf")}
          </div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
            {t("details.set_name")}
          </label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          <label className="mb-1.5 mt-[13px] block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
            {t("details.set_qiraa")}
          </label>
          <select
            value={qiraa}
            onChange={(e) => setQiraa(e.target.value)}
            className={`${inputClass} cursor-pointer`}
          >
            <option value="">{t("details.set_none")}</option>
            {(qiraat ?? []).map((q) => (
              <option key={q.name} value={q.name}>
                {q.name}
                {q.counting_system ? ` — ${q.counting_system}` : ""}
              </option>
            ))}
          </select>
          <div className="mt-[7px] text-[10.5px] leading-[1.5] text-text-muted">
            {t("details.set_countingFollows")}
            {mushaf.counting_system && (
              <b className="text-text-secondary">
                {t("details.set_countingDetail", {
                  name: mushaf.counting_system.name,
                  total: mushaf.counting_system.total_ayat,
                })}
              </b>
            )}
            {t("details.set_qiraatAvailable", { count: (qiraat ?? []).length })}
          </div>
          {error && (
            <div className="mt-2.5 rounded-md border border-error-border bg-error-bg px-3 py-2 text-[11.5px] text-error">
              {error}
            </div>
          )}
          <div className="mt-3.5 flex justify-end">
            <button
              type="button"
              onClick={onSaveMushaf}
              disabled={save.isPending}
              className="h-8 cursor-pointer rounded-lg bg-navy px-4 text-[11.5px] font-bold text-white transition-colors hover:bg-navy-hover disabled:opacity-50"
            >
              {save.isPending ? t("common.saving") : t("details.set_saveChanges")}
            </button>
          </div>
        </div>

        {/* Quran range card */}
        <div className="rounded-[11px] border border-border bg-white p-4">
          <div className="mb-3.5 flex items-center gap-2">
            <span className="text-[12.5px] font-bold text-text-primary">
              {t("details.set_quranRange")}
            </span>
            {locked && (
              <span className="rounded-[9px] bg-bg-muted px-[7px] py-0.5 font-mono text-[8.5px] font-bold tracking-[0.08em] text-text-secondary">
                {t("details.set_locked")}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <RangeField
              label={t("details.set_firstPage")}
              value={first}
              locked={locked}
              onChange={setFirst}
              max={mushaf.pdf_page_count}
            />
            <RangeField
              label={t("details.set_lastPage")}
              value={last}
              locked={locked}
              onChange={setLast}
              max={mushaf.pdf_page_count}
            />
          </div>
          <div className="mt-2.5 text-[10.5px] leading-[1.55] text-text-muted">
            {locked
              ? t("details.set_lockedNote", { count: mushaf.processed_page_count })
              : t("details.set_unlockedNote", { count: mushaf.pdf_page_count })}
          </div>
          {!locked && (
            <div className="mt-2.5 flex justify-end">
              <button
                type="button"
                onClick={onSaveBounds}
                disabled={save.isPending}
                className="h-8 cursor-pointer rounded-lg border border-border-strong bg-white px-4 text-[11.5px] font-semibold text-text-primary transition-colors hover:bg-bg-surface disabled:opacity-50"
              >
                {t("details.set_applyBounds")}
              </button>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-bg-surface px-[11px] py-2">
            <span className="text-[10.5px] text-text-secondary">{t("details.set_thumbNote")}</span>
            <button
              type="button"
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending}
              className="ms-auto cursor-pointer text-[10.5px] font-semibold text-orange hover:text-orange-hover disabled:opacity-50"
            >
              {regenerate.isPending ? t("details.set_rendering") : t("details.set_regenerate")}
            </button>
          </div>
        </div>
      </div>

      {/* sharing */}
      <div className="mt-3.5">
        <PublishPanel mushaf={mushaf} />
      </div>

      {/* danger zone */}
      <div className="mt-3.5 overflow-hidden rounded-[11px] border border-[color:var(--error-border)] bg-white">
        <div className="border-b border-error-bg px-4 py-[11px] text-[10px] font-bold uppercase tracking-[0.08em] text-error">
          {t("details.set_danger")}
        </div>
        <div className="flex items-center gap-3.5 border-b border-bg-surface px-4 py-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-text-primary">
              {t("details.set_reprocess")}
            </div>
            <div className="mt-px text-[11px] text-text-secondary">
              {t("details.set_reprocessDesc", { count: mushaf.processed_page_count })}
            </div>
          </div>
          <Link
            to="/mushafs/$mushafId/process"
            params={{ mushafId: mushaf.id }}
            className="ms-auto h-[30px] flex-none rounded-lg border border-border-strong bg-white px-[13px] text-[11.5px] font-semibold leading-[30px] text-text-primary transition-colors hover:bg-bg-surface"
          >
            {t("details.set_openProcess")}
          </Link>
        </div>
        <div className="flex items-center gap-3.5 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-text-primary">
              {t("details.set_deleteTitle")}
            </div>
            <div className="mt-px text-[11px] text-text-secondary">
              {t("details.set_deleteDesc", { count: mushaf.processed_page_count })}
            </div>
          </div>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t("details.set_deleteConfirm", { name: mushaf.name })))
                remove.mutate();
            }}
            className="ms-auto h-[30px] flex-none cursor-pointer rounded-lg border border-[color:var(--error-border)] bg-error-bg px-[13px] text-[11.5px] font-semibold text-error transition-colors hover:brightness-95 disabled:opacity-50"
          >
            {remove.isPending ? t("details.set_deleting") : t("details.set_deleteBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  locked,
  onChange,
  max,
}: {
  label: string;
  value: number;
  locked: boolean;
  onChange: (n: number) => void;
  max: number;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
        {label}
      </div>
      {locked ? (
        <div className="flex h-[34px] items-center rounded-lg border border-border bg-bg-surface px-[11px] font-mono text-[12.5px] font-semibold text-text-secondary">
          PDF p.{value}
        </div>
      ) : (
        <input
          type="number"
          min={1}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-[34px] w-full rounded-lg border-[1.5px] border-border-strong bg-white px-[11px] font-mono text-[12.5px] font-semibold text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]"
        />
      )}
    </div>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BusyLabel } from "@/components/app/SatrLoader";
import { PublishPanel } from "@/components/app/details/PublishPanel";
import {
  ApiError,
  deleteMushaf,
  queryKeys,
  regenerateThumbnail,
  updateMushaf,
  useQiraat,
  type IjamMode,
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
  const [ijam, setIjam] = useState<IjamMode>(mushaf.ijam_mode);
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
    if (ijam !== mushaf.ijam_mode) patch.ijam_mode = ijam;
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
    "h-[34px] w-full rounded-lg border-[1.5px] border-rule-2 bg-card px-[11px] text-[12.5px] font-medium text-ink outline-none focus:border-lapis focus:ring-3 focus:ring-lapis/15";

  return (
    <div>
      <div className="grid grid-cols-2 gap-3.5">
        {/* Mushaf card */}
        <div className="rounded-[11px] border border-rule bg-card p-4">
          <div className="mb-3.5 text-[12.5px] font-bold text-ink">{t("details.set_mushaf")}</div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-2">
            {t("details.set_name")}
          </label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          <label className="mb-1.5 mt-[13px] block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-2">
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
          <div className="mt-[7px] text-[10.5px] leading-[1.5] text-ink-3">
            {t("details.set_countingFollows")}
            {mushaf.counting_system && (
              <b className="text-ink-2">
                {t("details.set_countingDetail", {
                  name: mushaf.counting_system.name,
                  total: mushaf.counting_system.total_ayat,
                })}
              </b>
            )}
            {t("details.set_qiraatAvailable", { count: (qiraat ?? []).length })}
          </div>
          {/* Under the riwaya on purpose: both are facts about the printed book
              rather than about the work done on it, and this one is read by the
              same engine the riwaya feeds. Not disabled by `locked` — it changes
              nothing already written, and the only way to know whether it suits a
              mushaf is to run once and read how often a word is reported short. */}
          <label className="mb-1.5 mt-[13px] block text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-2">
            {t("details.set_ijam")}
          </label>
          <select
            value={ijam}
            onChange={(e) => setIjam(e.target.value as IjamMode)}
            className={`${inputClass} cursor-pointer`}
          >
            <option value="report">{t("details.set_ijamReport")}</option>
            <option value="ignore">{t("details.set_ijamIgnore")}</option>
          </select>
          <div className="mt-[7px] text-[10.5px] leading-[1.5] text-ink-3">
            {t("details.set_ijamHint")}
          </div>
          {error && (
            <div className="mt-2.5 rounded-md border border-stop/20 bg-stop-wash px-3 py-2 text-[11.5px] text-stop-text">
              {error}
            </div>
          )}
          <div className="mt-3.5 flex justify-end">
            <button
              type="button"
              onClick={onSaveMushaf}
              disabled={save.isPending}
              className="h-8 cursor-pointer rounded-lg bg-lapis px-4 text-[11.5px] font-bold text-on-lapis transition-colors hover:bg-lapis/90 disabled:opacity-50"
            >
              {save.isPending ? (
                <BusyLabel>{t("common.saving")}</BusyLabel>
              ) : (
                t("details.set_saveChanges")
              )}
            </button>
          </div>
        </div>

        {/* Quran range card */}
        <div className="rounded-[11px] border border-rule bg-card p-4">
          <div className="mb-3.5 flex items-center gap-2">
            <span className="text-[12.5px] font-bold text-ink">{t("details.set_quranRange")}</span>
            {locked && (
              <span className="rounded-[9px] bg-sunk px-[7px] py-0.5 font-mono text-[8.5px] font-bold tracking-[0.08em] text-ink-2">
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
          <div className="mt-2.5 text-[10.5px] leading-[1.55] text-ink-3">
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
                className="h-8 cursor-pointer rounded-lg border border-rule-2 bg-card px-4 text-[11.5px] font-semibold text-ink transition-colors hover:bg-sheet disabled:opacity-50"
              >
                {t("details.set_applyBounds")}
              </button>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-rule bg-sheet px-[11px] py-2">
            <span className="text-[10.5px] text-ink-2">{t("details.set_thumbNote")}</span>
            <button
              type="button"
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending}
              className="ms-auto cursor-pointer text-[10.5px] font-semibold text-lapis-text hover:text-lapis-text/80 disabled:opacity-50"
            >
              {regenerate.isPending ? (
                <BusyLabel>{t("details.set_rendering")}</BusyLabel>
              ) : (
                t("details.set_regenerate")
              )}
            </button>
          </div>
        </div>
      </div>

      {/* sharing */}
      <div className="mt-3.5">
        <PublishPanel mushaf={mushaf} />
      </div>

      {/* danger zone */}
      <div className="mt-3.5 overflow-hidden rounded-[11px] border border-stop/20 bg-card">
        <div className="border-b border-stop-wash px-4 py-[11px] text-[10px] font-bold uppercase tracking-[0.08em] text-stop-text">
          {t("details.set_danger")}
        </div>
        <div className="flex items-center gap-3.5 border-b border-sheet px-4 py-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-ink">{t("details.set_reprocess")}</div>
            <div className="mt-px text-[11px] text-ink-2">
              {t("details.set_reprocessDesc", { count: mushaf.processed_page_count })}
            </div>
          </div>
          <Link
            to="/mushafs/$mushafId/process"
            params={{ mushafId: mushaf.id }}
            className="ms-auto h-[30px] flex-none rounded-lg border border-rule-2 bg-card px-[13px] text-[11.5px] font-semibold leading-[30px] text-ink transition-colors hover:bg-sheet"
          >
            {t("details.set_openProcess")}
          </Link>
        </div>
        <div className="flex items-center gap-3.5 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-ink">{t("details.set_deleteTitle")}</div>
            <div className="mt-px text-[11px] text-ink-2">
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
            className="ms-auto h-[30px] flex-none cursor-pointer rounded-lg border border-stop/20 bg-stop-wash px-[13px] text-[11.5px] font-semibold text-stop-text transition-colors hover:brightness-95 disabled:opacity-50"
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
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-2">
        {label}
      </div>
      {locked ? (
        <div className="flex h-[34px] items-center rounded-lg border border-rule bg-sheet px-[11px] font-mono text-[12.5px] font-semibold text-ink-2">
          PDF p.{value}
        </div>
      ) : (
        <input
          type="number"
          min={1}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-[34px] w-full rounded-lg border-[1.5px] border-rule-2 bg-card px-[11px] font-mono text-[12.5px] font-semibold text-ink outline-none focus:border-lapis focus:ring-3 focus:ring-lapis/15"
        />
      )}
    </div>
  );
}

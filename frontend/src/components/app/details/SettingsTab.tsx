import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { DeleteMushafDialog } from "@/components/app/DeleteMushafDialog";
import { BusyLabel } from "@/components/app/SatrLoader";
import {
  ApiError,
  pageImageUrl,
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
  const [deleting, setDeleting] = useState(false);

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
    "h-11 w-full rounded-control border border-rule-2 bg-card px-3.5 text-[15px] text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)]";
  const mushafDirty =
    name.trim() !== mushaf.name || (qiraa || null) !== mushaf.qiraa || ijam !== mushaf.ijam_mode;
  const label = "flex flex-col gap-1.5";
  const labelText = "text-[13px] font-semibold text-ink-2";

  return (
    <div className="flex max-w-[920px] flex-col gap-6">
      {/* Mushaf */}
      <Section title={t("details.set_mushaf")} sub={t("hub.setMushafSub")}>
        <div className="flex flex-col gap-4 p-[22px]">
          <label className={label}>
            <span className={labelText}>{t("details.set_name")}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              dir="auto"
              className={inputClass}
            />
          </label>
          <label className={label}>
            <span className={labelText}>{t("details.set_qiraa")}</span>
            <select
              value={qiraa}
              onChange={(e) => setQiraa(e.target.value)}
              className={`${inputClass} cursor-pointer px-3`}
            >
              <option value="">{t("details.set_none")}</option>
              {(qiraat ?? []).map((q) => (
                <option key={q.name} value={q.name}>
                  {q.name}
                  {q.counting_system ? ` — ${q.counting_system}` : ""}
                </option>
              ))}
            </select>
            <span className="text-[12.5px] leading-normal text-ink-3">
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
            </span>
          </label>
          {/* Under the riwaya on purpose: both are facts about the printed book
              rather than about the work done on it, and this one is read by the
              same engine the riwaya feeds. Not disabled by `locked` — it changes
              nothing already written, and the only way to know whether it suits a
              mushaf is to run once and read how often a word is reported short. */}
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className={`${labelText} pb-1.5`}>{t("details.set_ijam")}</legend>
            <div role="radiogroup" className="flex flex-wrap gap-2">
              {(["report", "ignore"] as const).map((mode) => (
                <label
                  key={mode}
                  className={`flex cursor-pointer items-center gap-2 rounded-control border px-3.5 py-2.5 text-[14px] ${
                    ijam === mode ? "border-lapis bg-lapis-wash text-lapis-text" : "border-rule-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="ijam"
                    checked={ijam === mode}
                    onChange={() => setIjam(mode)}
                    className="h-4 w-4 cursor-pointer accent-lapis"
                  />
                  {mode === "report" ? t("details.set_ijamReport") : t("details.set_ijamIgnore")}
                </label>
              ))}
            </div>
            <span className="text-[12.5px] leading-normal text-ink-3">
              {t("details.set_ijamHint")}
            </span>
          </fieldset>
          {error && (
            <div className="rounded-lg border border-stop/20 bg-stop-wash px-3.5 py-2.5 text-[13.5px] text-stop-text">
              {error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule-soft bg-sheet px-[22px] py-3.5">
          {!mushafDirty && (
            <span className="me-auto text-[13px] text-ink-3">{t("hub.setNothingChanged")}</span>
          )}
          <button
            type="button"
            onClick={onSaveMushaf}
            disabled={save.isPending || !mushafDirty}
            className="inline-flex h-10 cursor-pointer items-center rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50"
          >
            {save.isPending ? (
              <BusyLabel>{t("common.saving")}</BusyLabel>
            ) : (
              t("details.set_saveChanges")
            )}
          </button>
        </div>
      </Section>

      {/* Quran range */}
      <Section
        title={t("details.set_quranRange")}
        badge={locked ? t("details.set_locked") : undefined}
        sub={t("hub.setRangeSub", { count: mushaf.pdf_page_count })}
      >
        <div className="flex flex-col gap-3 p-[22px]">
          <div className="grid grid-cols-2 gap-3">
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
          <span className="text-[12.5px] leading-normal text-ink-3">
            {locked
              ? t("details.set_lockedNote", { count: mushaf.processed_page_count })
              : t("details.set_unlockedNote", { count: mushaf.pdf_page_count })}
          </span>
          {!locked && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onSaveBounds}
                disabled={save.isPending}
                className="inline-flex h-10 cursor-pointer items-center rounded-control border border-rule-2 bg-card px-4 text-[13.5px] font-semibold text-ink transition-colors hover:bg-sheet disabled:opacity-50"
              >
                {t("details.set_applyBounds")}
              </button>
            </div>
          )}
        </div>
      </Section>

      {/* Cover */}
      <Section title={t("hub.setCover")} sub={t("hub.setCoverSub")}>
        <div className="flex items-center gap-4 p-[22px]">
          <CoverThumb mushaf={mushaf} />
          <span className="flex flex-col items-start gap-2">
            <span className="text-[13.5px] text-ink-2">{t("details.set_thumbNote")}</span>
            <button
              type="button"
              onClick={() => regenerate.mutate()}
              disabled={regenerate.isPending}
              className="inline-flex h-9 cursor-pointer items-center rounded-control border border-rule-2 bg-card px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-sheet disabled:opacity-50"
            >
              {regenerate.isPending ? (
                <BusyLabel>{t("details.set_rendering")}</BusyLabel>
              ) : (
                t("details.set_regenerate")
              )}
            </button>
          </span>
        </div>
      </Section>

      {/* Danger zone */}
      <section className="overflow-hidden rounded-panel border border-stop/30 bg-card">
        <div className="border-b border-stop/20 px-[22px] py-3.5">
          <h2 className="m-0 font-display text-[20px] font-semibold text-stop-text">
            {t("details.set_danger")}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3.5 border-b border-rule-soft px-[22px] py-4">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-[14px]">{t("details.set_reprocess")}</strong>
            <span className="text-[13px] text-ink-2">
              {t("details.set_reprocessDesc", { count: mushaf.processed_page_count })}
            </span>
          </span>
          <Link
            to="/mushafs/$mushafId/process"
            params={{ mushafId: mushaf.id }}
            className="inline-flex h-10 flex-none items-center rounded-control border border-rule-2 bg-card px-4 text-[13.5px] font-semibold text-ink no-underline transition-colors hover:bg-sheet"
          >
            {t("details.set_openProcess")}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-3.5 px-[22px] py-4">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-[14px]">{t("details.set_deleteTitle")}</strong>
            <span className="text-[13px] text-ink-2">
              {t("details.set_deleteDesc", { count: mushaf.processed_page_count })}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setDeleting(true)}
            className="inline-flex h-10 flex-none cursor-pointer items-center rounded-control bg-stop px-4 text-[13.5px] font-semibold text-on-stop transition-colors hover:bg-stop/90"
          >
            {t("details.set_deleteBtn")}
          </button>
          <DeleteMushafDialog
            mushaf={mushaf}
            open={deleting}
            onOpenChange={setDeleting}
            onDeleted={() => void navigate({ to: "/" })}
          />
        </div>
      </section>
    </div>
  );
}

/** A settings section: a title (and a badge) with its line, then the body. */
function Section({
  title,
  sub,
  badge,
  children,
}: {
  title: string;
  sub?: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-panel border border-rule bg-card">
      <div className="flex flex-col gap-0.5 border-b border-rule-soft px-[22px] py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="m-0 font-display text-[20px] font-semibold">{title}</h2>
          {badge && (
            <span className="rounded-[4px] bg-sunk px-2 py-0.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-ink-2">
              {badge}
            </span>
          )}
        </div>
        {sub && <span className="text-[13px] text-ink-3">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

function CoverThumb({ mushaf }: { mushaf: MushafDetail }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  return (
    <span className="h-[104px] w-[78px] flex-none overflow-hidden rounded-[4px] border border-rule-2 bg-page shadow-[var(--shadow-card)]">
      {!failed && (
        <img
          src={mushaf.thumbnail_url ?? pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
          alt={t("details.rail_coverAlt", { name: mushaf.name })}
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover object-top"
        />
      )}
    </span>
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
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-ink-2">{label}</span>
      <input
        type="number"
        min={1}
        max={max}
        value={value}
        disabled={locked}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 w-full rounded-control border border-rule-2 bg-card px-3 font-mono text-[14px] font-medium text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)] disabled:bg-sheet disabled:text-ink-2"
      />
    </label>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BusyLabel } from "@/components/app/SatrLoader";
import {
  ApiError,
  bundleUrl,
  importBundle,
  queryKeys,
  type MushafDetail,
  type PageSummary,
} from "@/lib/api";

/** Download / import of the portable work bundle (schema mushaf-work/v1).
 *
 * The bundle carries the work but not the PDF — it names the PDF by checksum,
 * and the server refuses an import whose checksum does not match this mushaf.
 * That refusal is the feature, so the UI explains it rather than just relaying
 * the status code.
 */
export function BundlePanel({
  mushaf,
  summaries,
}: {
  mushaf: MushafDetail;
  summaries: PageSummary[] | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const processedCount = summaries?.length ?? 0;
  const hasWork = processedCount > 0;

  const run = useMutation({
    mutationFn: () => importBundle(mushaf.id, file!, replace),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushaf.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushaf.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats(mushaf.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushaf.id) });
      toast.success(
        t("bundle.imported", { pages: result.pages_imported, name: result.source_name }),
      );
      if (result.warnings.bounds_differ) toast.warning(t("bundle.warnBounds"));
      if (result.warnings.page_count_differs) toast.warning(t("bundle.warnPageCount"));
      setFile(null);
      setReplace(false);
      setError(null);
      setHint(null);
      if (fileInput.current) fileInput.current.value = "";
    },
    onError: (e) => {
      const isApi = e instanceof ApiError;
      setError(isApi ? e.message : t("bundle.importFailed"));
      // A 409 is either "wrong PDF" or "already has work". The first needs
      // explaining — the server message alone reads like a dead end.
      setHint(isApi && e.status === 409 && !replace && !hasWork ? t("bundle.mismatchHint") : null);
    },
  });

  function onImport() {
    setError(null);
    setHint(null);
    if (!file) return setError(t("bundle.fileRequired"));
    run.mutate();
  }

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-rule bg-card p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 font-display text-[20px] font-semibold">{t("bundle.title")}</h2>
        <span className="rounded-[4px] bg-sunk px-2 py-0.5 font-mono text-[12px] text-ink-2">
          {t("bundle.schema")}
        </span>
      </div>
      <p className="m-0 text-[13.5px] leading-normal text-ink-2">{t("bundle.body")}</p>
      <a
        href={hasWork ? bundleUrl(mushaf.id) : undefined}
        download
        aria-disabled={!hasWork}
        className={`inline-flex h-10 items-center justify-center rounded-control border border-ink px-4 text-[13.5px] font-semibold no-underline transition-colors ${
          hasWork ? "text-ink hover:bg-sunk" : "pointer-events-none text-ink-3 opacity-50"
        }`}
      >
        {hasWork ? t("bundle.download") : t("bundle.noData")}
      </a>

      <div className="my-1 h-px bg-rule-soft" />

      <span className="text-[14px] font-semibold">{t("bundle.importTitle")}</span>
      <span className="text-[13px] leading-normal text-ink-3">{t("bundle.importBody")}</span>
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setError(null);
          setHint(null);
        }}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-control border border-dashed border-rule-2 bg-sheet px-4 text-[13.5px] font-semibold text-ink-2 hover:border-lapis hover:text-lapis-text"
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        {file
          ? t("bundle.selected", { name: file.name, size: Math.round(file.size / 1024) })
          : t("bundle.chooseFile")}
      </button>

      {hasWork && file && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-stop-wash px-3.5 py-3 text-stop-text">
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
            className="mt-0.5 h-4 w-4 cursor-pointer accent-stop"
          />
          <span className="text-[13px] leading-normal">
            <b className="block">{t("bundle.replaceLabel")}</b>
            {t("bundle.replaceWarning", { count: processedCount })}
          </span>
        </label>
      )}

      {error && (
        <div className="rounded-lg border border-stop/20 bg-stop-wash px-3.5 py-2.5 text-[13px] leading-normal text-stop-text">
          {error}
          {hint && <span className="mt-1 block text-ink-2">{hint}</span>}
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={onImport}
          disabled={run.isPending || (hasWork && !replace)}
          className={`inline-flex h-10 cursor-pointer items-center justify-center rounded-control px-4 text-[13.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            hasWork
              ? "bg-stop text-on-stop hover:bg-stop/90"
              : "bg-lapis text-on-lapis hover:bg-lapis/90"
          }`}
        >
          {run.isPending ? <BusyLabel>{t("bundle.importing")}</BusyLabel> : t("bundle.import")}
        </button>
      )}
    </section>
  );
}

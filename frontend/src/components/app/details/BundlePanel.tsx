import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
    <div className="mt-3.5 grid grid-cols-2 gap-3.5">
      {/* Export */}
      <div className="rounded-[11px] border border-border bg-white p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-orange-tint text-orange">
            <Package className="h-3.5 w-3.5" />
          </span>
          <span className="text-[12.5px] font-bold text-text-primary">{t("bundle.title")}</span>
          <span
            className={`ms-auto rounded-pill px-2 py-0.5 text-[10px] font-semibold ${
              hasWork ? "bg-success-bg text-success" : "bg-bg-muted text-text-secondary"
            }`}
          >
            {hasWork ? t("bundle.ready") : t("bundle.noData")}
          </span>
        </div>

        <p className="mt-3 text-[10.5px] leading-[1.55] text-text-muted">{t("bundle.body")}</p>

        <div className="mt-3.5 flex flex-col gap-1.5">
          <KvRow k={t("details.kv_schema")} v={t("bundle.schema")} />
        </div>

        <a
          href={hasWork ? bundleUrl(mushaf.id) : undefined}
          download
          aria-disabled={!hasWork}
          className={`mt-[15px] block h-[34px] rounded-lg border border-border-strong text-center text-[12px] font-bold leading-[32px] transition-colors ${
            hasWork
              ? "bg-white text-text-primary hover:bg-bg-surface"
              : "pointer-events-none bg-bg-muted text-text-muted opacity-60"
          }`}
        >
          {t("bundle.download")}
        </a>
      </div>

      {/* Import */}
      <div className="rounded-[11px] border border-border bg-white p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-bg-muted text-text-secondary">
            <Upload className="h-3.5 w-3.5" />
          </span>
          <span className="text-[12.5px] font-bold text-text-primary">
            {t("bundle.importTitle")}
          </span>
        </div>

        <p className="mt-3 text-[10.5px] leading-[1.55] text-text-muted">
          {t("bundle.importBody")}
        </p>

        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
            setHint(null);
          }}
          className="mt-3 w-full cursor-pointer text-[11px] text-text-secondary file:me-3 file:cursor-pointer file:rounded file:border-0 file:bg-bg-muted file:px-2 file:py-1 file:text-[11px] file:font-medium"
        />
        {file && (
          <div className="mt-1 text-[10.5px] text-text-muted">
            {t("bundle.selected", { name: file.name, size: Math.round(file.size / 1024) })}
          </div>
        )}

        {hasWork && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-2.5 py-2">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              className="mt-0.5 cursor-pointer"
            />
            <span className="text-[10.5px] leading-[1.5] text-[#8a4b0d]">
              <b className="block">{t("bundle.replaceLabel")}</b>
              {t("bundle.replaceWarning", { count: processedCount })}
            </span>
          </label>
        )}

        {error && (
          <div className="mt-2.5 rounded-md border border-error-border bg-error-bg px-3 py-2 text-[11.5px] leading-[1.5] text-error">
            {error}
            {hint && <span className="mt-1 block text-text-secondary">{hint}</span>}
          </div>
        )}

        <Button
          size="sm"
          className="mt-[15px] w-full"
          onClick={onImport}
          disabled={run.isPending || !file || (hasWork && !replace)}
        >
          {run.isPending ? t("bundle.importing") : t("bundle.import")}
        </Button>
      </div>
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-text-muted">{k}</span>
      <span className="font-mono text-[10.5px] font-semibold text-text-primary">{v}</span>
    </div>
  );
}

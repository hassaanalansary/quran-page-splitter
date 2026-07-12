import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  ApiError,
  coordinatesUrl,
  exportLines,
  queryKeys,
  type MushafDetail,
  type MushafStats,
  type PageSummary,
} from "@/lib/api";

export function ExportTab({
  mushaf,
  stats,
  summaries,
}: {
  mushaf: MushafDetail;
  stats: MushafStats | undefined;
  summaries: PageSummary[] | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const processed = summaries ?? [];
  const reviewedPages = processed.filter((s) => s.reviewed);
  const linesCut = stats?.lines_cut ?? 0;
  const exported = stats?.exported_pngs ?? 0;
  const ayat = stats?.ayat_found ?? 0;
  const pngPct = linesCut > 0 ? Math.round((exported / linesCut) * 100) : 0;

  async function exportAll(onlyReviewed: boolean) {
    const targets = (onlyReviewed ? reviewedPages : processed).map((s) => s.page_number);
    if (targets.length === 0) {
      toast.info(onlyReviewed ? t("details.ex_noReviewed") : t("details.ex_noProcessed"));
      return;
    }
    setProgress({ done: 0, total: targets.length });
    try {
      for (const [index, pageNumber] of targets.entries()) {
        await exportLines(mushaf.id, pageNumber);
        setProgress({ done: index + 1, total: targets.length });
      }
      toast.success(t("details.ex_exportedToast", { count: targets.length }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("details.ex_exportFailed"));
    } finally {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.stats(mushaf.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushaf.id) });
    }
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3.5">
        {/* Line images · PNG */}
        <div className="rounded-[11px] border border-border bg-white p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-orange-tint text-[14px] text-orange">
              ⤓
            </span>
            <span className="text-[12.5px] font-bold text-text-primary">
              {t("details.ex_pngTitle")}
            </span>
            <span
              className={`ms-auto rounded-pill px-2 py-0.5 text-[10px] font-semibold ${
                exported === 0
                  ? "bg-bg-muted text-text-secondary"
                  : exported >= linesCut
                    ? "bg-success-bg text-success"
                    : "bg-warning-bg text-[#8a4b0d]"
              }`}
            >
              {exported === 0
                ? t("details.ex_notStarted")
                : exported >= linesCut
                  ? t("details.ex_complete")
                  : t("details.ex_partial")}
            </span>
          </div>
          <div className="mt-[15px] flex items-baseline gap-2">
            <span className="text-[27px] font-extrabold text-navy">{exported}</span>
            <span className="text-[12px] font-medium text-text-muted">
              {t("details.ex_ofLines", { count: linesCut })}
            </span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-[3px] bg-bg-muted">
            <div className="h-full bg-success" style={{ width: `${pngPct}%` }} />
          </div>
          <div className="mt-3.5 flex flex-col gap-1.5">
            <KvRow k={t("details.kv_format")} v="transparent PNG" />
            <KvRow k={t("details.kv_path")} v="media/lines/…" />
            <KvRow k={t("details.kv_naming")} v="{mushaf}_p{page}_l{line}.png" />
          </div>
          <div className="mt-[15px] flex gap-2">
            <button
              type="button"
              disabled={!!progress || processed.length === 0}
              onClick={() => exportAll(false)}
              className="h-[34px] flex-1 cursor-pointer rounded-lg bg-navy text-[12px] font-bold text-white transition-colors hover:bg-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {progress
                ? t("details.ex_exporting", { done: progress.done, total: progress.total })
                : t("details.ex_exportAll")}
            </button>
            <button
              type="button"
              disabled={!!progress || reviewedPages.length === 0}
              onClick={() => exportAll(true)}
              className="h-[34px] cursor-pointer rounded-lg border border-border-strong bg-white px-3 text-[12px] font-semibold text-text-primary transition-colors hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("details.ex_reviewedBtn", { count: reviewedPages.length })}
            </button>
          </div>
        </div>

        {/* Aya coordinates · JSON */}
        <div className="rounded-[11px] border border-border bg-white p-4">
          <div className="flex items-center gap-2">
            <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-orange-tint font-mono text-[11px] font-semibold text-orange">
              {"{ }"}
            </span>
            <span className="text-[12.5px] font-bold text-text-primary">
              {t("details.ex_jsonTitle")}
            </span>
            <span
              className={`ms-auto rounded-pill px-2 py-0.5 text-[10px] font-semibold ${
                ayat > 0 ? "bg-success-bg text-success" : "bg-bg-muted text-text-secondary"
              }`}
            >
              {ayat > 0 ? t("details.ex_ready") : t("details.ex_noData")}
            </span>
          </div>
          <div className="mt-[15px] flex items-baseline gap-2">
            <span className="text-[27px] font-extrabold text-navy">{ayat}</span>
            <span className="text-[12px] font-medium text-text-muted">
              {t("details.ex_ayatAcross", { count: processed.length })}
            </span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-[3px] bg-bg-muted">
            <div className="h-full bg-success" style={{ width: ayat > 0 ? "100%" : "0%" }} />
          </div>
          <div className="mt-3.5 flex flex-col gap-1.5">
            <KvRow k={t("details.kv_schema")} v="aya-bbox/v1" />
            <KvRow k={t("details.kv_perAya")} v="{ sura, aya, rects[] }" />
            <KvRow k={t("details.kv_rect")} v="{ x, y, w, h }" />
          </div>
          <div className="mt-[15px] flex gap-2">
            <a
              href={coordinatesUrl(mushaf.id)}
              download
              className="h-[34px] flex-1 rounded-lg border border-border-strong bg-white text-center text-[12px] font-bold leading-[34px] text-text-primary transition-colors hover:bg-bg-surface"
            >
              {t("details.ex_downloadJson")}
            </a>
          </div>
        </div>
      </div>

      {/* review warning */}
      {processed.length > 0 && reviewedPages.length < processed.length && (
        <div className="mt-3.5 flex items-center gap-3 rounded-[11px] border border-border bg-white px-4 py-[13px]">
          <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-warning-bg text-[13px] text-[#8a4b0d]">
            !
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-text-primary">
              {t("details.ex_onlyReviewed", {
                reviewed: reviewedPages.length,
                total: processed.length,
              })}
            </div>
            <div className="mt-px text-[11px] text-text-secondary">
              {t("details.ex_reviewWarn")}
            </div>
          </div>
          <Link
            to="/mushafs/$mushafId/review"
            params={{ mushafId: mushaf.id }}
            search={{ page: processed.find((s) => !s.reviewed)?.page_number ?? 1 }}
            className="ms-auto flex-none text-[11.5px] font-bold text-orange hover:text-orange-hover"
          >
            {t("details.ex_goReview")}
          </Link>
        </div>
      )}
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="font-mono text-[10.5px] font-medium text-text-secondary">{k}</span>
      <span className="font-mono text-[10.5px] font-bold text-text-primary">{v}</span>
    </div>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BundlePanel } from "@/components/app/details/BundlePanel";
import { PublishPanel } from "@/components/app/details/PublishPanel";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ApiError,
  coordinatesUrl,
  exportLines,
  exportUrl,
  LINE_PNG_SIZES,
  linesZipUrl,
  queryKeys,
  updateMushaf,
  useCalibrationPages,
  type LinePngSize,
  type MushafDetail,
  type MushafStats,
  type PageSummary,
} from "@/lib/api";

const PRIMARY =
  "inline-flex h-10 cursor-pointer items-center justify-center rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis no-underline transition-colors hover:bg-lapis/90 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "inline-flex h-10 cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card px-4 text-[13.5px] font-semibold text-ink no-underline transition-colors hover:bg-sheet disabled:cursor-not-allowed disabled:opacity-50";

/** One export: its title and state, the headline number, then the rest. */
function ExportSection({
  title,
  pill,
  children,
}: {
  title: string;
  pill: { label: string; tone: "done" | "warn" | "plain" };
  children: ReactNode;
}) {
  const tone =
    pill.tone === "done"
      ? "bg-done-wash text-done-text"
      : pill.tone === "warn"
        ? "bg-warn-wash text-warn-text"
        : "bg-sunk text-ink-2";
  const dot = pill.tone === "done" ? "bg-done" : pill.tone === "warn" ? "bg-warn" : "bg-ink-4";
  return (
    <section className="flex flex-col gap-3.5 rounded-panel border border-rule bg-card p-[22px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 font-display text-[22px] font-semibold">{title}</h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-pill px-2.5 py-[3px] text-[12px] font-semibold ${tone}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {pill.label}
        </span>
      </div>
      {children}
    </section>
  );
}

function Headline({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="font-display text-[32px] font-semibold leading-none">
        {value.toLocaleString()}
      </span>
      <span className="text-[13.5px] text-ink-3">{label}</span>
    </div>
  );
}

function KvList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-6 gap-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2 border-b border-rule-soft py-1">
          <dt className="font-mono text-[12px] text-ink-3">{k}</dt>
          <dd className="m-0 truncate font-mono text-[12px] font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

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

  const pngSize = useMutation({
    mutationFn: (value: LinePngSize) => updateMushaf(mushaf.id, { line_png_size: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushaf.id) }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("details.ex_sizeFailed")),
  });

  const processed = summaries ?? [];
  const reviewedPages = processed.filter((s) => s.reviewed);
  const linesCut = stats?.lines_cut ?? 0;
  const exported = stats?.exported_pngs ?? 0;
  const ayat = stats?.ayat_found ?? 0;
  const pngShare = linesCut > 0 ? Math.min(1, exported / linesCut) : 0;

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
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <ExportSection
          title={t("details.ex_pngTitle")}
          pill={
            exported === 0
              ? { label: t("details.ex_notStarted"), tone: "plain" }
              : exported >= linesCut
                ? { label: t("details.ex_complete"), tone: "done" }
                : { label: t("details.ex_partial"), tone: "warn" }
          }
        >
          <Headline value={exported} label={t("details.ex_ofLines", { count: linesCut })} />
          <div className="h-1.5 rounded-[3px] bg-sunk">
            <div className="h-1.5 rounded-[3px] bg-done" style={{ width: `${pngShare * 100}%` }} />
          </div>
          <KvList
            rows={[
              [t("details.kv_format"), "transparent PNG"],
              [t("details.kv_path"), "media/mushafs/{id}/lines/…"],
              [t("details.kv_naming"), "page-{page}/line-{line}.png"],
            ]}
          />

          {/* Line PNG size. Persisted on the mushaf rather than asked per export,
              so a mushaf cannot end up half one size and half another. */}
          <fieldset className="m-0 flex flex-col gap-2 rounded-card border border-rule bg-sheet p-3.5">
            <legend className="float-left mb-1.5 w-full text-[14px] font-semibold">
              {t("details.ex_sizeLabel")}
            </legend>
            <div role="radiogroup" className="flex flex-col gap-1.5">
              {LINE_PNG_SIZES.map((size) => (
                <label
                  key={size}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5 ${
                    mushaf.line_png_size === size
                      ? "border-lapis bg-lapis-wash"
                      : "border-rule-2 bg-card"
                  }`}
                >
                  <input
                    type="radio"
                    name="line-png-size"
                    checked={mushaf.line_png_size === size}
                    disabled={pngSize.isPending}
                    onChange={() => pngSize.mutate(size)}
                    className="mt-0.5 h-4 w-4 flex-none cursor-pointer accent-lapis"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13.5px] font-semibold">
                      {t(`details.ex_size_${size}`)}
                    </span>
                    <span className="text-[12.5px] leading-snug text-ink-3">
                      {t(`details.ex_size_${size}Help`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {exported > 0 && (
              <span className="text-[12.5px] leading-snug text-ink-3">
                {t("details.ex_sizeReexport")}
              </span>
            )}
          </fieldset>

          {processed.length > 0 && reviewedPages.length < processed.length && (
            <div className="flex items-start gap-2.5 rounded-lg bg-warn-wash px-3.5 py-[11px] text-[13.5px] leading-[1.45] text-warn-text">
              <span aria-hidden="true">⚠</span>
              <span>
                <strong>
                  {t("details.ex_onlyReviewed", {
                    reviewed: reviewedPages.length,
                    total: processed.length,
                  })}
                </strong>{" "}
                {t("details.ex_reviewWarn")}{" "}
                <Link
                  to="/mushafs/$mushafId/review"
                  params={{ mushafId: mushaf.id }}
                  search={{ page: processed.find((s) => !s.reviewed)?.page_number ?? 1 }}
                  className="font-semibold text-warn-text underline"
                >
                  {t("details.ex_goReview")}
                </Link>
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!!progress || reviewedPages.length === 0}
              onClick={() => exportAll(true)}
              className={PRIMARY}
            >
              {t("details.ex_reviewedBtn", { count: reviewedPages.length })}
            </button>
            <button
              type="button"
              disabled={!!progress || processed.length === 0}
              onClick={() => exportAll(false)}
              className={SECONDARY}
            >
              {progress
                ? t("details.ex_exporting", { done: progress.done, total: progress.total })
                : t("details.ex_exportAll")}
            </button>
            {/* Pull the PNGs out of media/ in one go, saved wherever the browser asks. */}
            {exported > 0 && (
              <a href={linesZipUrl(mushaf.id)} download className={SECONDARY}>
                {t("details.ex_downloadZip")}
              </a>
            )}
          </div>
        </ExportSection>

        <ExportSection
          title={t("details.ex_jsonTitle")}
          pill={
            ayat > 0
              ? { label: t("details.ex_ready"), tone: "done" }
              : { label: t("details.ex_noData"), tone: "plain" }
          }
        >
          <Headline value={ayat} label={t("details.ex_ayatAcross", { count: processed.length })} />
          <KvList
            rows={[
              [t("details.kv_schema"), "aya-bbox/v1"],
              [t("details.kv_perAya"), "{ sura, aya, rects[] }"],
              [t("details.kv_rect"), "{ x, y, w, h }"],
            ]}
          />
          <div>
            <a href={coordinatesUrl(mushaf.id)} download className={PRIMARY}>
              {t("details.ex_downloadJson")}
            </a>
          </div>
        </ExportSection>

        <FullExport mushafId={mushaf.id} />
      </div>

      <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
        <PublishPanel mushaf={mushaf} />
        {/* The work itself, portable, as opposed to the rendered artifacts. */}
        <BundlePanel mushaf={mushaf} summaries={summaries} />
      </aside>
    </div>
  );
}

/**
 * The full data export (schema mushaf-export/v2): every line, aya, word and blob — each
 * blob with its class and, for a mark, its type — in page pixels and in each line PNG's
 * own, with every line's word map and blob map. Calibrated pages carry the blobs; the
 * rest carry their word boxes. See backend/api/services/data_export.py.
 */
function FullExport({ mushafId }: { mushafId: string }) {
  const { t } = useTranslation();
  const { data: states } = useCalibrationPages(mushafId);
  const [images, setImages] = useState(true);
  const [maps, setMaps] = useState(true);
  const confirmed = (states ?? []).filter((row) => row.confirmed_revision !== null).length;
  const drafts = (states ?? []).filter(
    (row) => row.processed && row.confirmed_revision === null,
  ).length;

  return (
    <ExportSection
      title={t("details.ex_fullTitle")}
      pill={
        confirmed + drafts > 0
          ? { label: t("details.ex_fullPill", { count: confirmed + drafts }), tone: "done" }
          : { label: t("details.ex_fullWordsOnly"), tone: "plain" }
      }
    >
      <Headline value={confirmed} label={t("details.ex_fullConfirmed")} />
      <p className="m-0 text-[13.5px] leading-normal text-ink-2">
        {drafts > 0
          ? t("details.ex_fullDrafts", { count: drafts })
          : confirmed > 0
            ? t("details.ex_fullAllConfirmed")
            : t("details.ex_fullNone")}
      </p>
      <KvList
        rows={[
          [t("details.kv_schema"), "mushaf-export/v2"],
          [t("details.kv_spaces"), "page px + line-PNG px"],
          [t("details.kv_perWord"), "{ id, ref, text, box, ink }"],
          [t("details.kv_perBlob"), "{ class, type, words, box }"],
          [t("details.kv_maps"), "words + blobs PNG"],
        ]}
      />
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
          <Checkbox checked={images} onCheckedChange={(value) => setImages(value === true)} />
          {t("details.ex_fullImages")}
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
          <Checkbox checked={maps} onCheckedChange={(value) => setMaps(value === true)} />
          {t("details.ex_fullMaps")}
        </label>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <a href={exportUrl(mushafId, { images, maps })} download className={PRIMARY}>
          {t("details.ex_fullDownload")}
        </a>
        <p className="m-0 text-[12.5px] leading-snug text-ink-3">{t("details.ex_fullHelp")}</p>
      </div>
    </ExportSection>
  );
}

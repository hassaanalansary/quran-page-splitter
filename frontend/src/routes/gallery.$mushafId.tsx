import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ChevronLeft, Copy, Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { OrnamentStrip } from "@/components/app/Ornament";
import { ErrorState, STATE_SECONDARY } from "@/components/app/States";
import { BusyLabel } from "@/components/app/SatrLoader";
import { fmtDate } from "@/components/app/details/helpers";
import {
  ApiError,
  duplicateMushaf,
  galleryCoordinatesUrl,
  galleryExportUrl,
  galleryLinesZipUrl,
  mushafStatus,
  queryKeys,
  useGalleryItem,
  useSession,
  type GalleryDetail,
  type MushafStatus,
} from "@/lib/api";

/** A published mushaf, read only.
 *
 * Public, like the gallery listing. This page deliberately links to **no** step
 * route (setup/templates/process/review/finalize/ink): publishing grants read and
 * nothing else, so a visitor is never shown a door they cannot open. The owner
 * gets one link into their own workspace, and that is the only way out of here
 * into an editor.
 *
 * Page chrome lives in the `/gallery` layout route; this renders the content.
 */
export const Route = createFileRoute("/gallery/$mushafId")({ component: GalleryDetailPage });

function GalleryDetailPage() {
  const { mushafId } = Route.useParams();
  const { t } = useTranslation();
  const { data, isPending, isError, error } = useGalleryItem(mushafId);

  if (isPending || isError) {
    return (
      <>
        <section className="bg-deep text-on-deep">
          <OrnamentStrip />
          <div className="mx-auto flex max-w-[1240px] flex-col gap-[18px] px-7 pb-[34px] pt-[22px]">
            <BackLink />
            {isPending ? (
              <div className="flex flex-wrap gap-x-11 gap-y-7">
                <div className="h-[270px] w-[200px] animate-pulse bg-on-deep/10" />
                <div className="flex flex-[1_1_520px] flex-col gap-3">
                  <div className="h-10 w-2/3 animate-pulse rounded bg-on-deep/10" />
                  <div className="h-4 w-1/3 animate-pulse rounded bg-on-deep/10" />
                  <div className="h-20 animate-pulse rounded bg-on-deep/10" />
                </div>
              </div>
            ) : null}
          </div>
        </section>
        {isError && (
          <div className="mx-auto max-w-[1240px] px-7 py-7">
            {error instanceof ApiError && error.status === 404 ? (
              <ErrorState
                tone="gone"
                title={t("gallery.detail.gone")}
                body={t("gallery.detail.goneHint")}
                className="max-w-[460px]"
              >
                <Link to="/gallery" className={STATE_SECONDARY}>
                  {t("gallery.backToGallery")}
                </Link>
              </ErrorState>
            ) : (
              <ErrorState
                title={t("gallery.loadFailed")}
                body={error instanceof Error ? error.message : undefined}
                className="max-w-[460px]"
              >
                <Link to="/gallery" className={STATE_SECONDARY}>
                  {t("gallery.backToGallery")}
                </Link>
              </ErrorState>
            )}
          </div>
        )}
      </>
    );
  }

  return <DetailBody item={data} />;
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/gallery"
      className="inline-flex items-center gap-1.5 self-start text-[13.5px] font-medium text-on-deep-2 no-underline hover:text-on-deep"
    >
      <ChevronLeft className="h-[15px] w-[15px] rtl:rotate-180" aria-hidden="true" />
      {t("gallery.backToGallery")}
    </Link>
  );
}

const STATUS_CHIP: Record<MushafStatus, { dot: string; chip: string }> = {
  empty: { dot: "bg-ink-4", chip: "bg-sunk text-ink-3" },
  partial: { dot: "bg-warn", chip: "bg-warn-wash text-warn-text" },
  processed: { dot: "bg-lapis", chip: "bg-lapis-wash text-lapis-text" },
  completed: { dot: "bg-done", chip: "bg-done-wash text-done-text" },
};

const ON_DEEP_BUTTON =
  "inline-flex h-11 items-center gap-2 rounded-control border border-on-deep/35 px-4 text-[14px] font-semibold text-on-deep no-underline transition-colors hover:bg-on-deep/10";

function DetailBody({ item }: { item: GalleryDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: user } = useSession();
  const [imgFailed, setImgFailed] = useState(false);

  const copy = useMutation({
    mutationFn: () => duplicateMushaf(item.id),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("gallery.duplicated", { name: created.name }));
      navigate({ to: "/mushafs/$mushafId", params: { mushafId: created.id } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("gallery.duplicateFailed")),
  });

  const status = mushafStatus(item);
  const total = item.logical_page_count;
  const hasLines = item.exported_line_count > 0;
  const byline = [
    item.is_owner ? t("gallery.byYou") : t("gallery.by", { name: item.owner_name }),
    item.published_at && t("gallery.detail.publishedOn", { date: fmtDate(item.published_at) }),
    item.updated_at && t("gallery.detail.updatedOn", { date: fmtDate(item.updated_at) }),
  ].filter(Boolean);
  const primary =
    "inline-flex h-11 items-center gap-2 rounded-control bg-gold px-[18px] text-[14.5px] font-bold text-on-gold no-underline transition-colors hover:bg-gold/90 disabled:cursor-default disabled:opacity-70";

  return (
    <>
      <section className="bg-deep text-on-deep">
        <OrnamentStrip />
        <div className="mx-auto flex max-w-[1240px] flex-col gap-[18px] px-7 pb-[34px] pt-[22px]">
          <BackLink />
          <div className="flex flex-wrap items-start gap-x-11 gap-y-7">
            <div className="relative h-[270px] w-[200px] flex-none overflow-hidden bg-page shadow-[0_16px_40px_rgba(0,0,0,0.4)]">
              {item.thumbnail_url && !imgFailed ? (
                <img
                  src={item.thumbnail_url}
                  alt={item.name}
                  draggable={false}
                  onError={() => setImgFailed(true)}
                  className="h-full w-full object-cover object-top"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[11px] text-ink-3">
                  {t("home.noPreview")}
                </div>
              )}
            </div>

            <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-3">
              <span
                className={`inline-flex items-center gap-1.5 self-start rounded-pill px-2.5 py-1 text-[12.5px] font-semibold ${STATUS_CHIP[status].chip}`}
              >
                <span className={`h-[7px] w-[7px] rounded-full ${STATUS_CHIP[status].dot}`} />
                {t(`status.${status}`)} · {t(`gallery.detail.visibility.${item.visibility}`)}
              </span>
              <h1 dir="auto" className="m-0 font-display text-[42px] font-semibold leading-[1.05]">
                {item.name}
              </h1>
              <div className="text-[14px] text-on-deep-2">{byline.join(" · ")}</div>
              {item.description ? (
                // The card clamps the description to two lines, so anything longer
                // is only readable here.
                <p className="m-0 mt-1 max-w-[640px] whitespace-pre-line text-[15.5px] leading-[1.6] text-on-deep">
                  {item.description}
                </p>
              ) : (
                <p className="m-0 mt-1 text-[15px] italic text-on-deep-2">
                  {t("gallery.detail.noDescription")}
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-2.5">
                {item.is_owner ? (
                  <Link to="/mushafs/$mushafId" params={{ mushafId: item.id }} className={primary}>
                    {t("gallery.openYours")}
                    <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
                  </Link>
                ) : user ? (
                  <button
                    type="button"
                    onClick={() => copy.mutate()}
                    disabled={copy.isPending}
                    className={`${primary} cursor-pointer`}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    {copy.isPending ? (
                      <BusyLabel>{t("gallery.duplicating")}</BusyLabel>
                    ) : (
                      t("gallery.duplicate")
                    )}
                  </button>
                ) : (
                  <Link
                    to="/auth/login"
                    search={{ next: `/gallery/${item.id}` }}
                    className={primary}
                  >
                    {t("gallery.signInToDuplicate")}
                  </Link>
                )}
                <a href={galleryCoordinatesUrl(item.id)} download className={ON_DEEP_BUTTON}>
                  <Download className="h-[15px] w-[15px]" aria-hidden="true" />
                  {t("gallery.downloadJson")}
                </a>
                {/* Not an <a> when there is nothing to download: an <a> has no
                    disabled state. */}
                {hasLines ? (
                  <a href={galleryLinesZipUrl(item.id)} download className={ON_DEEP_BUTTON}>
                    <Download className="h-[15px] w-[15px]" aria-hidden="true" />
                    {t("gallery.downloadZip")}
                  </a>
                ) : (
                  <button type="button" disabled className={`${ON_DEEP_BUTTON} opacity-50`}>
                    <Download className="h-[15px] w-[15px]" aria-hidden="true" />
                    {t("gallery.downloadZip")}
                  </button>
                )}
              </div>
              {!item.is_owner && (
                <div className="text-[12.5px] text-on-deep-2">
                  {t("gallery.detail.copyNote", { name: item.owner_name })}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-7 px-7 pb-9 pt-7">
        <section
          aria-label={t("gallery.detail.facts")}
          className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px overflow-hidden rounded-card border border-rule bg-rule"
        >
          <Fact label={t("gallery.detail.qiraa")} value={item.qiraa ?? "—"} capitalize />
          <Fact
            label={t("gallery.detail.quranPages")}
            value={total.toLocaleString()}
            sub={t("gallery.detail.pdfSub", {
              count: item.pdf_page_count,
              first: item.first_quran_pdf_page,
              last: item.last_quran_pdf_page,
            })}
          />
          <Fact
            label={t("gallery.detail.reviewed")}
            value={item.reviewed_page_count.toLocaleString()}
            of={t("gallery.detail.ofTotal", { total })}
            sub={
              item.processed_page_count >= total
                ? t("gallery.detail.allProcessed")
                : t("gallery.detail.processedCount", { count: item.processed_page_count })
            }
          />
          <Fact label={t("gallery.detail.lines")} value={item.line_count.toLocaleString()} />
          <Fact
            label={t("gallery.detail.lineImages")}
            value={item.exported_line_count.toLocaleString()}
            sub={t("gallery.detail.transparentPng")}
          />
        </section>

        <section className="flex flex-col gap-3.5">
          <h2 className="m-0 font-display text-[24px] font-semibold">
            {t("gallery.detail.downloads")}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
            <DownloadCard
              title={t("gallery.detail.coordinatesTitle")}
              format="JSON"
              body={t("gallery.detail.coordinatesBody")}
            >
              <a
                href={galleryCoordinatesUrl(item.id)}
                download
                className="mt-auto inline-flex h-10 items-center justify-center rounded-control bg-lapis text-[14px] font-semibold text-on-lapis no-underline transition-colors hover:bg-lapis/90"
              >
                {t("gallery.detail.downloadJson")}
              </a>
            </DownloadCard>
            <DownloadCard
              title={t("gallery.detail.imagesTitle")}
              format="ZIP"
              body={t("gallery.detail.imagesBody", { count: item.exported_line_count })}
            >
              {hasLines ? (
                <a
                  href={galleryLinesZipUrl(item.id)}
                  download
                  className="mt-auto inline-flex h-10 items-center justify-center rounded-control border border-ink text-[14px] font-semibold text-ink no-underline transition-colors hover:bg-sunk"
                >
                  {t("gallery.detail.downloadImages")}
                </a>
              ) : (
                <>
                  <p className="m-0 text-[12.5px] text-ink-3">{t("gallery.detail.noLineImages")}</p>
                  <button
                    type="button"
                    disabled
                    className="mt-auto inline-flex h-10 items-center justify-center rounded-control border border-ink text-[14px] font-semibold text-ink opacity-50"
                  >
                    {t("gallery.detail.downloadImages")}
                  </button>
                </>
              )}
            </DownloadCard>
            <DownloadCard
              title={t("gallery.detail.fullTitle")}
              format="mushaf-export/v2"
              body={t("gallery.detail.fullBody")}
            >
              {/* Every line, aya, word and blob, with the pixel maps: the export a
                  downstream app reads. See backend/api/services/data_export.py. */}
              <a
                href={galleryExportUrl(item.id)}
                download
                className="mt-auto inline-flex h-10 items-center justify-center rounded-control border border-ink text-[14px] font-semibold text-ink no-underline transition-colors hover:bg-sunk"
              >
                {t("gallery.detail.downloadFull")}
              </a>
            </DownloadCard>
          </div>
        </section>
      </div>
    </>
  );
}

function Fact({
  label,
  value,
  of,
  sub,
  capitalize = false,
}: {
  label: string;
  value: string;
  of?: string;
  sub?: string;
  capitalize?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 bg-card px-[18px] py-4">
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        {label}
      </span>
      <span className={`font-display text-[26px] font-semibold ${capitalize ? "capitalize" : ""}`}>
        {value}
        {of && <span className="ms-1.5 text-[16px] text-ink-3">{of}</span>}
      </span>
      {sub && <span className="text-[12.5px] text-ink-3">{sub}</span>}
    </div>
  );
}

function DownloadCard({
  title,
  format,
  body,
  children,
}: {
  title: string;
  format: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-rule bg-card p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[16px] font-semibold">{title}</span>
        <span
          dir="ltr"
          className="rounded-[4px] bg-sunk px-2 py-0.5 font-mono text-[12px] text-ink-2"
        >
          {format}
        </span>
      </div>
      <p className="m-0 text-[13.5px] leading-[1.55] text-ink-2">{body}</p>
      {children}
    </div>
  );
}

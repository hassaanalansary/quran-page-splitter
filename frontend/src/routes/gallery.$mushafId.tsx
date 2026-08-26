import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Copy, Download, FileJson } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { fmtDate } from "@/components/app/details/helpers";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  duplicateMushaf,
  galleryCoordinatesUrl,
  galleryLinesZipUrl,
  queryKeys,
  useGalleryItem,
  useSession,
  type GalleryDetail,
} from "@/lib/api";

/** A published mushaf, read only.
 *
 * Public, like the gallery listing. This page deliberately links to **no** step
 * route (setup/templates/process/review/finalize): publishing grants read and
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

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <Link
        to="/gallery"
        className="mb-6 inline-flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:text-navy"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        {t("gallery.backToGallery")}
      </Link>

      {isError ? (
        <NotAvailable
          message={
            error instanceof ApiError && error.status === 404
              ? t("gallery.detail.gone")
              : error instanceof Error
                ? error.message
                : t("gallery.loadFailed")
          }
        />
      ) : isPending ? (
        <div className="grid gap-8 md:grid-cols-[260px_1fr]">
          <div className="aspect-[3/4] animate-pulse rounded-xl bg-bg-muted" />
          <div className="space-y-3">
            <div className="h-8 w-2/3 animate-pulse rounded bg-bg-muted" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-bg-muted" />
            <div className="h-24 animate-pulse rounded bg-bg-muted" />
          </div>
        </div>
      ) : (
        <DetailBody item={data} />
      )}
    </div>
  );
}

function NotAvailable({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-white/50 px-6 py-12 text-center">
      <p className="text-sm font-medium text-text-primary">{message}</p>
      <p className="mt-1 text-sm text-text-muted">{t("gallery.detail.goneHint")}</p>
      <Button asChild size="sm" variant="outline" className="mt-4">
        <Link to="/gallery">{t("gallery.backToGallery")}</Link>
      </Button>
    </div>
  );
}

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

  const facts: { label: string; value: string }[] = [
    { label: t("gallery.detail.qiraa"), value: item.qiraa ?? "—" },
    { label: t("gallery.detail.quranPages"), value: String(item.logical_page_count) },
    {
      label: t("gallery.detail.processed"),
      value: t("gallery.detail.ofPages", {
        done: item.processed_page_count,
        total: item.logical_page_count,
      }),
    },
    {
      label: t("gallery.detail.reviewed"),
      value: t("gallery.detail.ofPages", {
        done: item.reviewed_page_count,
        total: item.logical_page_count,
      }),
    },
    { label: t("gallery.detail.lines"), value: item.line_count.toLocaleString() },
    { label: t("gallery.detail.lineImages"), value: item.exported_line_count.toLocaleString() },
    {
      label: t("gallery.detail.sourcePdf"),
      value: t("gallery.detail.pdfRange", {
        count: item.pdf_page_count,
        first: item.first_quran_pdf_page,
        last: item.last_quran_pdf_page,
      }),
    },
    {
      label: t("gallery.detail.published"),
      value: item.published_at ? fmtDate(item.published_at) : "—",
    },
    {
      label: t("gallery.detail.updated"),
      value: item.updated_at ? fmtDate(item.updated_at) : "—",
    },
  ];

  return (
    <div className="grid gap-8 md:grid-cols-[260px_1fr]">
      {/* Cover */}
      <div className="overflow-hidden rounded-xl border border-border bg-bg-muted shadow-[var(--shadow-sm)]">
        <div className="aspect-[3/4]">
          {item.thumbnail_url && !imgFailed ? (
            <img
              src={item.thumbnail_url}
              alt={item.name}
              draggable={false}
              onError={() => setImgFailed(true)}
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
              {t("home.noPreview")}
            </div>
          )}
        </div>
      </div>

      {/* Everything else */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <MushafStatusBadge mushaf={item} size="md" />
          {item.is_owner && (
            <span className="rounded-pill bg-navy/85 px-2.5 py-1 text-[11px] font-semibold text-white">
              {t("gallery.yours")}
            </span>
          )}
        </div>

        <h1 className="mt-3 font-display text-2xl font-bold text-navy">{item.name}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {item.is_owner ? t("gallery.byYou") : t("gallery.by", { name: item.owner_name })}
        </p>

        {item.description ? (
          // The whole point of this page: the card clamps the description to two
          // lines, so anything longer is only readable here.
          <p className="mt-5 max-w-2xl whitespace-pre-line text-sm leading-relaxed text-text-secondary">
            {item.description}
          </p>
        ) : (
          <p className="mt-5 text-sm italic text-text-muted">{t("gallery.detail.noDescription")}</p>
        )}

        <dl className="mt-7 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-4 border-t border-border pt-6">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {fact.label}
              </dt>
              <dd className="mt-0.5 text-sm font-medium capitalize text-text-primary">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-8 flex flex-wrap items-center gap-2.5 border-t border-border pt-6">
          {item.is_owner ? (
            <Button asChild>
              <Link to="/mushafs/$mushafId" params={{ mushafId: item.id }}>
                {t("gallery.openYours")}
                <ArrowRight className="h-4 w-4 rtl:rotate-180" />
              </Link>
            </Button>
          ) : user ? (
            <Button onClick={() => copy.mutate()} disabled={copy.isPending}>
              <Copy className="h-4 w-4" />
              {copy.isPending ? t("gallery.duplicating") : t("gallery.duplicate")}
            </Button>
          ) : (
            <Button asChild>
              <Link to="/auth/login" search={{ next: `/gallery/${item.id}` }}>
                {t("gallery.signInToDuplicate")}
              </Link>
            </Button>
          )}

          <Button asChild variant="outline">
            <a href={galleryCoordinatesUrl(item.id)} download>
              <FileJson className="h-4 w-4" />
              {t("gallery.downloadJson")}
            </a>
          </Button>
          {/* Not `asChild` + `disabled`: an <a> has no disabled state, so the
              empty case has to be a real button that does nothing. */}
          {item.exported_line_count > 0 ? (
            <Button asChild variant="outline">
              <a href={galleryLinesZipUrl(item.id)} download>
                <Download className="h-4 w-4" />
                {t("gallery.downloadZip")}
              </a>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              <Download className="h-4 w-4" />
              {t("gallery.downloadZip")}
            </Button>
          )}
        </div>

        {item.exported_line_count === 0 && (
          <p className="mt-2.5 text-[12px] text-text-muted">{t("gallery.detail.noLineImages")}</p>
        )}
      </div>
    </div>
  );
}

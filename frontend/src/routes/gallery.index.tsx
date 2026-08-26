import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Copy, Download, FileJson } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  duplicateMushaf,
  galleryCoordinatesUrl,
  galleryLinesZipUrl,
  queryKeys,
  useGallery,
  useSession,
  type GalleryItem,
} from "@/lib/api";

/** The listing. Page chrome (header, scroll container) lives in the `/gallery`
 * layout route; this renders only the content inside it. */
export const Route = createFileRoute("/gallery/")({ component: GalleryPage });

function GalleryPage() {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const { data, isPending, isError, error } = useGallery(null, offset);
  const { data: user } = useSession();

  return (
    <div className="mx-auto max-w-6xl px-8 py-9">
      <div className="mb-7">
        <h1 className="font-display text-2xl font-bold text-navy">{t("gallery.title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t("gallery.subtitle")}</p>
        {/* Signed out, this page is the front door — say what the app does
                and where the account gets you, rather than leaving a stranger
                to infer it from a grid of covers. */}
        {!user && (
          <p className="mt-3 max-w-2xl text-sm text-text-muted">
            {t("gallery.anonIntro")}{" "}
            <Link
              to="/auth/signup"
              className="font-semibold text-orange underline-offset-2 hover:underline"
            >
              {t("gallery.anonIntroCta")}
            </Link>
          </p>
        )}
      </div>

      {isError ? (
        <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
          {error instanceof Error ? error.message : t("gallery.loadFailed")}
        </div>
      ) : isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[330px] animate-pulse rounded-xl bg-bg-muted" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-white/50 px-6 py-12 text-center">
          <p className="text-sm font-medium text-text-primary">{t("gallery.empty")}</p>
          <p className="mt-1 text-sm text-text-muted">{t("gallery.emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-5">
            {data.items.map((item) => (
              <GalleryCard key={item.id} item={item} />
            ))}
          </div>
          {data.total > data.items.length + offset && (
            <div className="mt-8 flex flex-col items-center gap-2">
              <Button variant="outline" onClick={() => setOffset(offset + data.items.length)}>
                {t("gallery.more")}
              </Button>
              <span className="text-xs text-text-muted">
                {t("gallery.showingCount", {
                  shown: offset + data.items.length,
                  total: data.total,
                })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GalleryCard({ item }: { item: GalleryItem }) {
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

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-white shadow-[var(--shadow-sm)] transition hover:border-border-strong hover:shadow-[var(--shadow-md)]">
      <Link
        to="/gallery/$mushafId"
        params={{ mushafId: item.id }}
        className="relative block aspect-[3/4] overflow-hidden bg-bg-muted"
      >
        {item.thumbnail_url && !imgFailed ? (
          <img
            src={item.thumbnail_url}
            alt={item.name}
            loading="lazy"
            draggable={false}
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
            {t("home.noPreview")}
          </div>
        )}
        <MushafStatusBadge mushaf={item} className="absolute start-2 top-2" />
        {item.is_owner && (
          <span className="absolute end-2 top-2 rounded-pill bg-navy/85 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
            {t("gallery.yours")}
          </span>
        )}
      </Link>

      <div className="flex flex-1 flex-col border-t border-border px-3 py-2.5">
        <Link
          to="/gallery/$mushafId"
          params={{ mushafId: item.id }}
          className="truncate text-[13px] font-semibold text-text-primary hover:text-orange"
        >
          {item.name}
        </Link>
        <p className="mt-0.5 truncate text-[11px] text-text-muted">
          {item.is_owner ? t("gallery.byYou") : t("gallery.by", { name: item.owner_name })}
        </p>
        {item.description && (
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-text-secondary">
            {item.description}
          </p>
        )}

        <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
          <span>
            {t("gallery.pages", {
              done: item.processed_page_count,
              total: item.logical_page_count,
            })}
          </span>
          {item.qiraa && <span className="capitalize">{item.qiraa}</span>}
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          {item.is_owner ? (
            // You cannot usefully copy something into the account it is already
            // in — offer the way in to the real thing instead.
            <Button asChild size="sm" variant="outline">
              <Link to="/mushafs/$mushafId" params={{ mushafId: item.id }}>
                {t("gallery.openYours")}
                <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </Link>
            </Button>
          ) : user ? (
            <Button size="sm" onClick={() => copy.mutate()} disabled={copy.isPending}>
              <Copy className="h-3.5 w-3.5" />
              {copy.isPending ? t("gallery.duplicating") : t("gallery.duplicate")}
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline">
              {/* Copying writes rows that must belong to someone. */}
              <Link to="/auth/login" search={{ next: "/gallery" }}>
                {t("gallery.signInToDuplicate")}
              </Link>
            </Button>
          )}

          <div className="flex gap-1.5">
            <a
              href={galleryCoordinatesUrl(item.id)}
              download
              title={t("gallery.downloadJson")}
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded-[7px] border border-border-strong text-[11px] font-semibold text-text-secondary transition-colors hover:bg-bg-surface"
            >
              <FileJson className="h-3.5 w-3.5" />
              JSON
            </a>
            <a
              href={galleryLinesZipUrl(item.id)}
              download
              title={t("gallery.downloadZip")}
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded-[7px] border border-border-strong text-[11px] font-semibold text-text-secondary transition-colors hover:bg-bg-surface"
            >
              <Download className="h-3.5 w-3.5" />
              ZIP
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

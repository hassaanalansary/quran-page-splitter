import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CreateMushafDialog } from "@/components/app/CreateMushafDialog";
import { LanguageSwitcher } from "@/components/app/LanguageSwitcher";
import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { UserMenu } from "@/components/app/UserMenu";
import { requireSessionOrGallery } from "@/lib/auth/guard";
import {
  ApiError,
  deleteMushaf,
  pageImageUrl,
  queryKeys,
  useMushafs,
  type Mushaf,
} from "@/lib/api";

export const Route = createFileRoute("/")({
  component: HomePage,
  // Anonymous visitors land on the public gallery instead of a sign-in form.
  beforeLoad: ({ context }) => requireSessionOrGallery(context.queryClient),
});

function HomePage() {
  const { t } = useTranslation();
  const { data: mushafs, isPending, isError, error } = useMushafs();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-page">
      <header className="flex h-[52px] flex-shrink-0 items-center border-b border-border bg-white px-6">
        <div className="flex items-center gap-2.5">
          <span className="mt-px h-2 w-2 rounded-[2px] bg-orange" />
          <span className="font-display text-[15px] font-bold leading-none text-navy">
            {t("common.appName")}
          </span>
        </div>
        <div className="ms-auto flex items-center gap-3">
          <Link
            to="/gallery"
            className="text-[12px] font-semibold text-text-secondary transition-colors hover:text-navy"
          >
            {t("gallery.navLink")}
          </Link>
          <LanguageSwitcher />
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-9">
          <div className="mb-7">
            <h1 className="font-display text-2xl font-bold text-navy">{t("home.title")}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t("home.subtitle")}</p>
          </div>

          {isError ? (
            <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
              {error instanceof Error ? error.message : t("home.loadFailed")}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-5">
              {isPending
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="aspect-[3/4.3] animate-pulse rounded-xl bg-bg-muted" />
                  ))
                : mushafs.map((m) => <MushafCard key={m.id} mushaf={m} />)}
              {!isPending && <AddCard onClick={() => setCreateOpen(true)} />}
            </div>
          )}
        </div>
      </main>

      <CreateMushafDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function MushafCard({ mushaf }: { mushaf: Mushaf }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [imgFailed, setImgFailed] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteMushaf(mushaf.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("home.deleted", { name: mushaf.name }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("home.deleteFailed")),
  });

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-white shadow-[var(--shadow-sm)] transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-md)]">
      <Link to="/mushafs/$mushafId" params={{ mushafId: mushaf.id }} className="block">
        {/* Thumbnail */}
        <div className="relative aspect-[3/4] overflow-hidden bg-bg-muted">
          {!imgFailed ? (
            <img
              src={mushaf.thumbnail_url ?? pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
              alt={t("home.cover", { name: mushaf.name })}
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
          <MushafStatusBadge mushaf={mushaf} className="absolute start-2 top-2" />
          {mushaf.visibility === "published" && (
            <span className="absolute bottom-2 start-2 flex items-center gap-1 rounded-pill bg-success-bg px-2 py-0.5 text-[10px] font-semibold text-success">
              <Globe size={9} />
              {t("gallery.publishedBadge")}
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-3 py-2.5">
          <h3 className="truncate text-[13px] font-semibold text-text-primary">{mushaf.name}</h3>
          <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
            <span>
              {t("home.pages", {
                done: mushaf.processed_page_count,
                total: mushaf.logical_page_count,
              })}
            </span>
            {mushaf.qiraa && <span className="capitalize">{mushaf.qiraa}</span>}
          </div>
        </div>
      </Link>

      <button
        type="button"
        aria-label={t("home.deleteAria", { name: mushaf.name })}
        title={t("home.deleteTitle")}
        onClick={() => {
          if (window.confirm(t("home.deleteConfirm", { name: mushaf.name }))) remove.mutate();
        }}
        disabled={remove.isPending}
        className="absolute end-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-white/80 text-text-secondary opacity-0 backdrop-blur transition hover:bg-error-bg hover:text-error group-hover:opacity-100 disabled:opacity-40"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function AddCard({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex aspect-[3/4.3] flex-col items-center justify-center gap-3 cursor-pointer rounded-xl border-2 border-dashed border-border-strong bg-white/40 text-text-secondary transition hover:border-orange hover:bg-orange-tint hover:text-orange"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-current">
        <Plus size={22} />
      </span>
      <span className="text-[13px] font-semibold">{t("home.newMushaf")}</span>
    </button>
  );
}

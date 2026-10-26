import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CreateMushafDialog } from "@/components/app/CreateMushafDialog";
import { ImportBundleDialog } from "@/components/app/ImportBundleDialog";
import { LanguageSwitcher } from "@/components/app/LanguageSwitcher";
import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { SatrLockup } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";
import { UserMenu } from "@/components/app/UserMenu";
import { Button } from "@/components/ui/button";
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
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <header className="flex h-[52px] flex-shrink-0 items-center border-b border-rule bg-card px-6">
        <SatrLockup />
        <div className="ms-auto flex items-center gap-3">
          <Link
            to="/gallery"
            className="text-[12px] font-semibold text-ink-2 transition-colors hover:text-lapis-text"
          >
            {t("gallery.navLink")}
          </Link>
          <ThemeButton />
          <LanguageSwitcher />
          <UserMenu />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-9">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-2xl font-bold text-lapis-text">{t("home.title")}</h1>
              <p className="mt-1 text-sm text-ink-2">{t("home.subtitle")}</p>
            </div>
            {/* Importing from here rather than from a mushaf: the bundle names
                its own mushaf by checksum, so there is nothing to look up first. */}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setImportOpen(true)}
            >
              <Upload size={14} />
              {t("bundle.detect.open")}
            </Button>
          </div>

          {isError ? (
            <div className="rounded-lg border border-stop/20 bg-stop-wash px-4 py-3 text-sm text-stop-text">
              {error instanceof Error ? error.message : t("home.loadFailed")}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-5">
              {isPending
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="aspect-[3/4.3] animate-pulse rounded-xl bg-sunk" />
                  ))
                : mushafs.map((m) => <MushafCard key={m.id} mushaf={m} />)}
              {!isPending && <AddCard onClick={() => setCreateOpen(true)} />}
            </div>
          )}
        </div>
      </main>

      <CreateMushafDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportBundleDialog open={importOpen} onOpenChange={setImportOpen} />
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
    <div className="group relative overflow-hidden rounded-xl border border-rule bg-card shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-rule-2 hover:shadow-[var(--shadow-lift)]">
      <Link to="/mushafs/$mushafId" params={{ mushafId: mushaf.id }} className="block">
        {/* Thumbnail */}
        <div className="relative aspect-[3/4] overflow-hidden bg-sunk">
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
            <div className="flex h-full items-center justify-center text-[11px] text-ink-3">
              {t("home.noPreview")}
            </div>
          )}
          <MushafStatusBadge mushaf={mushaf} className="absolute start-2 top-2" />
          {mushaf.visibility === "published" && (
            <span className="absolute bottom-2 start-2 flex items-center gap-1 rounded-pill bg-done-wash px-2 py-0.5 text-[10px] font-semibold text-done-text">
              <Globe size={9} />
              {t("gallery.publishedBadge")}
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-rule px-3 py-2.5">
          <h3 className="truncate text-[13px] font-semibold text-ink">{mushaf.name}</h3>
          <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
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
        className="absolute end-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-card/80 text-ink-2 opacity-0 backdrop-blur transition hover:bg-stop-wash hover:text-stop-text group-hover:opacity-100 disabled:opacity-40"
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
      className="group flex aspect-[3/4.3] flex-col items-center justify-center gap-3 cursor-pointer rounded-xl border-2 border-dashed border-rule-2 bg-card/40 text-ink-2 transition hover:border-lapis hover:bg-lapis-wash hover:text-lapis-text"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-current">
        <Plus size={22} />
      </span>
      <span className="text-[13px] font-semibold">{t("home.newMushaf")}</span>
    </button>
  );
}

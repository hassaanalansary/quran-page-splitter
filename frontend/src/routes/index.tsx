import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BilingualTitle } from "@/components/app/BilingualTitle";
import { CreateMushafDialog } from "@/components/app/CreateMushafDialog";
import { DeleteMushafDialog } from "@/components/app/DeleteMushafDialog";
import { ImportBundleDialog } from "@/components/app/ImportBundleDialog";
import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { OrnamentStrip } from "@/components/app/Ornament";
import { TopBar } from "@/components/app/TopBar";
import { useOtherLanguage } from "@/hooks/use-other-language";
import { requireSessionOrGallery } from "@/lib/auth/guard";
import { pageImageUrl, useMushafs, type Mushaf } from "@/lib/api";

export const Route = createFileRoute("/")({
  component: HomePage,
  // Anonymous visitors land on the public gallery instead of a sign-in form.
  beforeLoad: ({ context }) => requireSessionOrGallery(context.queryClient),
});

function HomePage() {
  const { t } = useTranslation();
  const other = useOtherLanguage();
  const { data: mushafs, isPending, isError, error } = useMushafs();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <TopBar current="mushafs" />

      <main className="flex-1 overflow-y-auto">
        <section className="bg-deep text-on-deep">
          <OrnamentStrip />
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-12 gap-y-6 px-7 py-[30px]">
            <div className="flex flex-[1_1_420px] flex-col gap-3.5">
              <BilingualTitle
                title={t("home.title")}
                other={other.t("home.title")}
                otherLang={other.lng}
              />
              <p className="m-0 max-w-[520px] text-[15.5px] leading-[1.55] text-on-deep-2">
                {t("home.subtitle")}
              </p>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-control bg-gold px-[18px] text-[14.5px] font-bold text-on-gold transition-colors hover:bg-gold/90"
                >
                  <Plus className="h-4 w-4" strokeWidth={2.6} aria-hidden="true" />
                  {t("home.newMushaf")}
                </button>
                {/* Importing from here rather than from a mushaf: the bundle names
                    its own mushaf by checksum, so there is nothing to look up first. */}
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-control border border-on-deep/35 px-4 text-[14px] font-semibold text-on-deep transition-colors hover:bg-on-deep/10"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  {t("bundle.detect.title")}
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-[30px] px-7 pb-9 pt-7">
          {isError ? (
            <div className="rounded-card border border-stop/20 bg-stop-wash px-4 py-3 text-sm text-stop-text">
              {error instanceof Error ? error.message : t("home.loadFailed")}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(214px,1fr))] gap-[18px]">
              {isPending
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="min-h-[300px] animate-pulse rounded-card bg-sunk" />
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

/** A labelled 4 px progress bar: lapis for processed, gold for reviewed. */
function Progress({
  label,
  done,
  total,
  tone,
}: {
  label: string;
  done: number;
  total: number;
  tone: "lapis" | "gold";
}) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <>
      <div className="flex justify-between text-[12px] text-ink-3">
        <span>{label}</span>
        <span className="font-mono">
          {done}/{total}
        </span>
      </div>
      <div className="h-1 rounded-[2px] bg-sunk">
        <div
          className={`h-1 rounded-[2px] ${tone === "lapis" ? "bg-lapis" : "bg-gold"}`}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </>
  );
}

function MushafCard({ mushaf }: { mushaf: Mushaf }) {
  const { t } = useTranslation();
  const [imgFailed, setImgFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-card border border-rule bg-card transition hover:border-rule-2 hover:shadow-[var(--shadow-lift)]">
      <Link
        to="/mushafs/$mushafId"
        params={{ mushafId: mushaf.id }}
        aria-label={t("home.open", { name: mushaf.name })}
        className="relative block h-[150px] overflow-hidden bg-well"
      >
        {!imgFailed ? (
          <img
            src={mushaf.thumbnail_url ?? pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setImgFailed(true)}
            className="absolute start-1/2 top-[18px] w-[118px] -translate-x-1/2 bg-page shadow-[var(--shadow-card)] rtl:translate-x-1/2"
          />
        ) : (
          <div className="absolute start-1/2 top-[18px] flex h-[160px] w-[118px] -translate-x-1/2 items-start justify-center bg-page pt-12 text-[11px] text-ink-3 shadow-[var(--shadow-card)] rtl:translate-x-1/2">
            {t("home.noPreview")}
          </div>
        )}
        <MushafStatusBadge mushaf={mushaf} size="md" className="absolute start-2.5 top-2.5" />
        {mushaf.visibility === "published" && (
          <span className="absolute bottom-2.5 start-2.5 inline-flex items-center gap-[5px] rounded-pill bg-done-wash px-[9px] py-[3px] text-[11.5px] font-semibold text-done-text">
            <Globe className="h-[11px] w-[11px]" strokeWidth={2.4} aria-hidden="true" />
            {t("gallery.publishedBadge")}
          </span>
        )}
      </Link>

      <button
        type="button"
        aria-label={t("home.deleteAria", { name: mushaf.name })}
        title={t("home.deleteTitle")}
        onClick={() => setDeleting(true)}
        className="absolute end-2.5 top-2.5 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-control bg-stop-wash text-stop-text opacity-0 transition hover:bg-stop hover:text-on-stop focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="h-[15px] w-[15px]" aria-hidden="true" />
      </button>

      <div className="flex flex-col gap-2 px-3.5 pb-[15px] pt-[13px]">
        <div className="flex items-baseline justify-between gap-2">
          <Link
            to="/mushafs/$mushafId"
            params={{ mushafId: mushaf.id }}
            className="min-w-0 truncate text-[15px] font-semibold text-ink no-underline hover:text-lapis-text"
          >
            {mushaf.name}
          </Link>
          {mushaf.qiraa && (
            <span className="flex-none text-[12px] capitalize text-ink-3">{mushaf.qiraa}</span>
          )}
        </div>
        <div className="flex flex-col gap-[5px]">
          <Progress
            label={t("home.processed")}
            done={mushaf.processed_page_count}
            total={mushaf.logical_page_count}
            tone="lapis"
          />
          <Progress
            label={t("home.reviewed")}
            done={mushaf.reviewed_page_count}
            total={mushaf.logical_page_count}
            tone="gold"
          />
        </div>
      </div>

      <DeleteMushafDialog mushaf={mushaf} open={deleting} onOpenChange={setDeleting} />
    </article>
  );
}

function AddCard({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[300px] cursor-pointer flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed border-rule-2 bg-transparent text-[14px] font-semibold text-ink-2 transition hover:border-lapis hover:bg-lapis-wash hover:text-lapis-text"
    >
      <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full border-2 border-current">
        <Plus className="h-[22px] w-[22px]" strokeWidth={2.4} aria-hidden="true" />
      </span>
      {t("home.newMushaf")}
      <span className="text-[12.5px] font-normal text-ink-3">{t("home.newMushafHint")}</span>
    </button>
  );
}

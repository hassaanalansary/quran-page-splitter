import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Download, Library, Search, SearchX } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { BilingualTitle } from "@/components/app/BilingualTitle";
import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { OrnamentStrip } from "@/components/app/Ornament";
import { BusyLabel } from "@/components/app/SatrLoader";
import { CardSkeleton, EmptyState, ErrorState, STATE_PRIMARY } from "@/components/app/States";
import { useOtherLanguage } from "@/hooks/use-other-language";
import { baseLanguage } from "@/i18n/config";
import {
  ApiError,
  duplicateMushaf,
  galleryCoordinatesUrl,
  galleryLinesZipUrl,
  queryKeys,
  useGallery,
  useSession,
  type GalleryItem,
  type GallerySort,
} from "@/lib/api";

/** The listing. Page chrome (top bar, scroll container) lives in the `/gallery`
 * layout route; this renders the hero, the filter bar and the cards. */
export const Route = createFileRoute("/gallery/")({ component: GalleryPage });

const SORTS: GallerySort[] = ["published", "complete", "name"];

/** `value`, once it has stopped changing for `delay` ms. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function GalleryPage() {
  const { t, i18n } = useTranslation();
  const { data: user } = useSession();
  const [searchText, setSearchText] = useState("");
  const search = useSettled(searchText, 250);
  const [qiraa, setQiraa] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [sort, setSort] = useState<GallerySort>("published");
  const gallery = useGallery({ qiraa, search, completed, sort });

  const pages = gallery.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const total = pages.at(-1)?.total ?? 0;
  const facets = pages[0]?.facets;
  const arabic = baseLanguage(i18n.language) === "ar";
  const filtered = Boolean(search.trim()) || qiraa !== null || completed;

  const chip = (pressed: boolean) =>
    `h-9 cursor-pointer rounded-pill px-3.5 text-[13px] transition-colors ${
      pressed
        ? "bg-ink font-semibold text-paper"
        : "border border-rule-2 bg-card font-medium text-ink-2 hover:border-ink-4"
    }`;

  return (
    <>
      <GalleryHero signedIn={Boolean(user)} />

      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5 px-7 pb-8 pt-6">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <label className="flex h-[42px] max-w-[420px] flex-[1_1_280px] items-center gap-2.5 rounded-control border border-rule-2 bg-card px-3 focus-within:border-lapis focus-within:shadow-[inset_0_0_0_1px_var(--lapis)]">
            <Search className="h-4 w-4 flex-none text-ink-4" aria-hidden="true" />
            <span className="sr-only">{t("gallery.searchLabel")}</span>
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("gallery.searchPlaceholder")}
              className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
            />
          </label>

          <div
            role="group"
            aria-label={t("gallery.filterLabel")}
            className="flex flex-wrap gap-1.5"
          >
            <button
              type="button"
              aria-pressed={qiraa === null}
              onClick={() => setQiraa(null)}
              className={chip(qiraa === null)}
            >
              {t("gallery.all", { count: facets?.all ?? total })}
            </button>
            {facets?.qiraat.map((facet) => (
              <button
                key={facet.name}
                type="button"
                aria-pressed={qiraa === facet.name}
                onClick={() => setQiraa(qiraa === facet.name ? null : facet.name)}
                className={chip(qiraa === facet.name)}
              >
                {arabic ? facet.name_arabic : facet.name}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={completed}
              onClick={() => setCompleted(!completed)}
              className={chip(completed)}
            >
              {t("gallery.completedOnly")}
            </button>
          </div>

          <label className="ms-auto flex items-center gap-2 text-[13px] text-ink-3">
            {t("gallery.sortLabel")}
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as GallerySort)}
              className="h-9 cursor-pointer rounded-control border border-rule-2 bg-card px-2.5 text-[13px] font-medium text-ink"
            >
              {SORTS.map((value) => (
                <option key={value} value={value}>
                  {t(`gallery.sort.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {gallery.isError ? (
          <ErrorState
            title={t("gallery.loadFailed")}
            body={gallery.error instanceof Error ? gallery.error.message : undefined}
            className="max-w-[460px]"
          >
            <button type="button" onClick={() => void gallery.refetch()} className={STATE_PRIMARY}>
              {t("errorPage.tryAgain")}
            </button>
          </ErrorState>
        ) : gallery.isPending ? (
          <div
            aria-busy="true"
            className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <CardSkeleton key={i} tall />
            ))}
          </div>
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<SearchX size={28} strokeWidth={1.6} aria-hidden="true" />}
              title={
                search.trim()
                  ? t("gallery.noMatchSearch", { search: search.trim() })
                  : t("gallery.noMatch")
              }
              body={t("gallery.noMatchHint")}
            >
              <button
                type="button"
                onClick={() => {
                  setSearchText("");
                  setQiraa(null);
                  setCompleted(false);
                }}
                className="h-[34px] cursor-pointer px-3 text-[13.5px] font-semibold text-lapis-text hover:underline"
              >
                {t("gallery.clearSearch")}
              </button>
            </EmptyState>
          ) : (
            <EmptyState
              icon={<Library size={28} strokeWidth={1.6} aria-hidden="true" />}
              title={t("gallery.empty")}
              body={t("gallery.emptyHint")}
            />
          )
        ) : (
          <>
            <div
              className={`grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5 transition-opacity ${
                gallery.isPlaceholderData ? "opacity-60" : ""
              }`}
            >
              {items.map((item) => (
                <GalleryCard key={item.id} item={item} />
              ))}
            </div>
            <div className="flex flex-col items-center gap-2 pt-1">
              {gallery.hasNextPage && (
                <button
                  type="button"
                  onClick={() => void gallery.fetchNextPage()}
                  disabled={gallery.isFetchingNextPage}
                  className="h-[42px] cursor-pointer rounded-control border border-ink px-[22px] text-[14px] font-semibold text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:opacity-60"
                >
                  {gallery.isFetchingNextPage ? (
                    <BusyLabel>{t("common.loading")}</BusyLabel>
                  ) : (
                    t("gallery.more")
                  )}
                </button>
              )}
              <span className="text-[12.5px] text-ink-3">
                {t("gallery.showingCount", { shown: items.length, total })}
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// The Quran words of the hero's illustration (an-Nas 1–5), as the board sets them.
const HERO_LINES = [
  ["قُلْ", "أَعُوذُ", "بِرَبِّ", "ٱلنَّاسِ", "۝١", "مَلِكِ", "ٱلنَّاسِ", "۝٢"],
  ["إِلَٰهِ", "ٱلنَّاسِ", "۝٣", "مِن", "شَرِّ", "ٱلْوَسْوَاسِ", "ٱلْخَنَّاسِ", "۝٤"],
  ["ٱلَّذِى", "يُوَسْوِسُ", "فِى", "صُدُورِ", "ٱلنَّاسِ", "۝٥"],
];

/** The deep band at the top: the bilingual title, what the gallery is, and for a
 * visitor the way to an account. */
function GalleryHero({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation();
  const other = useOtherLanguage();

  return (
    <section className="bg-deep text-on-deep">
      <OrnamentStrip />
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-12 gap-y-7 px-7 pb-[30px] pt-[34px]">
        <div className="flex flex-[1_1_460px] flex-col gap-3.5">
          <BilingualTitle
            title={t("gallery.title")}
            other={other.t("gallery.title")}
            otherLang={other.lng}
          />
          <p className="m-0 max-w-[560px] text-[16.5px] leading-[1.55] text-on-deep-2">
            {signedIn ? t("gallery.subtitle") : t("gallery.anonIntro")}
          </p>
          {!signedIn && (
            <div className="mt-1 flex flex-wrap gap-2.5">
              <Link
                to="/auth/signup"
                className="inline-flex h-11 items-center rounded-control bg-gold px-[18px] text-[14.5px] font-bold text-on-gold transition-colors hover:bg-gold/90"
              >
                {t("gallery.anonIntroCta")}
              </Link>
            </div>
          )}
        </div>

        {/* A page becoming lines: the page (it stays light, as scans do), then
            three of its lines, the middle one picked out. */}
        <div aria-hidden="true" className="relative h-[200px] flex-[0_1_520px]">
          <div className="absolute start-0 top-0 flex h-[200px] w-[150px] flex-col gap-[7px] bg-page px-3.5 py-4 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
            <div className="h-2.5 bg-band shadow-[inset_0_0_0_1px_var(--band-frame)]" />
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className={`h-1 rounded-[2px] ${i === 3 ? "bg-gold" : "bg-[#3A342C] opacity-70"}`}
              />
            ))}
          </div>
          <svg
            viewBox="0 0 60 200"
            width="60"
            height="200"
            className="absolute start-[156px] top-0 rtl:-scale-x-100"
          >
            {[
              "M4 70 C 30 70, 30 40, 56 40",
              "M4 100 C 30 100, 30 100, 56 100",
              "M4 130 C 30 130, 30 160, 56 160",
            ].map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                className="stroke-gold"
                strokeWidth="1.5"
                strokeDasharray="3 3"
              />
            ))}
          </svg>
          <div className="absolute end-0 start-[220px] top-5 flex flex-col gap-3.5">
            {HERO_LINES.map((words, i) => (
              <div
                key={i}
                lang="ar"
                dir="rtl"
                className={`flex h-10 items-center justify-between rounded px-3 font-quran text-[17px] text-on-deep ${
                  i === 1
                    ? "bg-gold/20 shadow-[inset_0_0_0_1.5px_var(--gold)]"
                    : "border border-dashed border-on-deep/40"
                }`}
              >
                {words.map((word, j) => (
                  <span key={j}>{word}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** "Oct 2026", in the UI's language with Western digits like the rest of the app. */
function monthYear(iso: string, lng: string): string {
  return new Intl.DateTimeFormat(`${baseLanguage(lng)}-u-nu-latn`, {
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function GalleryCard({ item }: { item: GalleryItem }) {
  const { t, i18n } = useTranslation();
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

  const total = item.logical_page_count;
  const done = item.processed_page_count;
  const share = total > 0 ? Math.min(1, done / total) : 0;
  const by = item.is_owner ? t("gallery.byYou") : t("gallery.by", { name: item.owner_name });
  const download =
    "inline-flex h-[34px] flex-1 items-center justify-center gap-1.5 rounded-control border border-rule-2 text-[12.5px] font-semibold text-ink no-underline transition-colors hover:bg-sheet";
  const third =
    "inline-flex h-[34px] cursor-pointer items-center justify-center rounded-control px-2.5 text-[12.5px] font-semibold text-lapis-text no-underline transition-colors hover:bg-lapis-wash disabled:cursor-default disabled:opacity-60";

  return (
    <article className="flex flex-col overflow-hidden rounded-card border border-rule bg-card">
      <Link
        to="/gallery/$mushafId"
        params={{ mushafId: item.id }}
        aria-label={t("gallery.open", { name: item.name })}
        className="relative block h-[150px] overflow-hidden bg-well"
      >
        {item.thumbnail_url && !imgFailed ? (
          <img
            src={item.thumbnail_url}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setImgFailed(true)}
            className="absolute start-1/2 top-[18px] w-[132px] -translate-x-1/2 bg-page shadow-[var(--shadow-card)] rtl:translate-x-1/2"
          />
        ) : (
          <div className="absolute start-1/2 top-[18px] flex h-[176px] w-[132px] -translate-x-1/2 items-start justify-center bg-page pt-12 text-[11px] text-ink-3 shadow-[var(--shadow-card)] rtl:translate-x-1/2">
            {t("home.noPreview")}
          </div>
        )}
        <MushafStatusBadge mushaf={item} size="md" className="absolute start-2.5 top-2.5" />
        {item.qiraa && (
          <span className="absolute end-2.5 top-2.5 rounded-pill bg-card px-2 py-[3px] text-[11.5px] font-semibold capitalize text-ink-2">
            {item.qiraa}
          </span>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-1.5 px-4 pb-4 pt-3.5">
        <Link
          to="/gallery/$mushafId"
          params={{ mushafId: item.id }}
          dir="auto"
          className="text-[15.5px] font-semibold text-ink no-underline hover:text-lapis-text"
        >
          {item.name}
        </Link>
        <span className="text-[12.5px] text-ink-3">
          {item.published_at ? `${by} · ${monthYear(item.published_at, i18n.language)}` : by}
        </span>
        <p className="mt-0.5 line-clamp-2 h-[39px] text-[13px] leading-normal text-ink-2">
          {item.description}
        </p>
        <div className="mt-0.5 flex items-center gap-2" title={t("gallery.pages", { done, total })}>
          <div className="h-[5px] flex-1 rounded-[3px] bg-sunk">
            <div className="h-[5px] rounded-[3px] bg-lapis" style={{ width: `${share * 100}%` }} />
          </div>
          <span className="font-mono text-[12px] text-ink-3">
            {done}/{total}
          </span>
        </div>
        <div className="mt-2 flex gap-1.5">
          <a
            href={galleryCoordinatesUrl(item.id)}
            download
            title={t("gallery.downloadJson")}
            className={download}
          >
            <Download className="h-[13px] w-[13px]" aria-hidden="true" />
            JSON
          </a>
          <a
            href={galleryLinesZipUrl(item.id)}
            download
            title={t("gallery.downloadZip")}
            className={download}
          >
            <Download className="h-[13px] w-[13px]" aria-hidden="true" />
            {t("gallery.cardZip")}
          </a>
          {item.is_owner ? (
            // You cannot usefully copy something into the account it is already
            // in: offer the way in to the real thing instead.
            <Link to="/mushafs/$mushafId" params={{ mushafId: item.id }} className={third}>
              {t("gallery.openYours")}
            </Link>
          ) : user ? (
            <button
              type="button"
              onClick={() => copy.mutate()}
              disabled={copy.isPending}
              title={t("gallery.duplicate")}
              className={third}
            >
              {copy.isPending ? (
                <BusyLabel>{t("gallery.duplicating")}</BusyLabel>
              ) : (
                t("gallery.duplicateShort")
              )}
            </button>
          ) : (
            // Copying writes rows that must belong to someone.
            <Link to="/auth/login" search={{ next: "/gallery" }} className={third}>
              {t("gallery.signInToDuplicate")}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

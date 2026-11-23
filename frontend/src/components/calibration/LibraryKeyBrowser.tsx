import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useLibraryKey, useLibraryKeys } from "@/lib/api";
import type { ContentsParts, LibraryKeyFilters, LibraryShape } from "@/lib/calibration/types";
import { cn } from "@/lib/utils";

import { InkCell } from "./InkCell";
import { useTypeName } from "./labels";

const CHIP =
  "h-8 rounded-control border border-rule-2 bg-card px-2.5 text-[12.5px] text-ink-2 hover:border-lapis aria-pressed:border-lapis aria-pressed:bg-lapis/10 aria-pressed:text-ink";
const FIELD =
  "h-8 w-24 rounded-control border border-rule-2 bg-card px-2 text-[13px] text-ink outline-none focus:border-lapis";

/** Where filters start once a person asks for bodies: the commonest keys first. */
const FIRST_FILTERS: LibraryKeyFilters = {
  letters: null,
  first: "",
  contains: "",
  show: "has",
  sort: "common",
  page: 1,
};

/** A key's letters, piece by piece, and the marks touching them — from its parts, never
 * from its written key. */
function KeyName({ parts }: { parts: ContentsParts | null }) {
  const typeName = useTypeName();
  const paws = (parts?.paws ?? []).map((piece) => piece ?? "?");
  const marks = (parts?.marks ?? []).map((mark) => (mark ? typeName(mark) : "?"));
  return (
    <span className="flex items-baseline gap-1.5">
      <span dir="rtl" className="font-quran text-[20px] leading-none text-ink">
        {paws.join(" + ")}
      </span>
      {marks.length > 0 && <span className="text-[12px] text-ink-3">+ {marks.join(" + ")}</span>}
    </span>
  );
}

/** The set's body keys, listed on demand: nothing loads until a filter is picked, then
 * 40 keys a page; a key opens to its pictures. The keys run to thousands by the end of a
 * mushaf, so the view never shows them all. */
export function LibraryKeyBrowser({
  mushafId,
  bodyKeys,
  zoom,
  onOpenShape,
}: {
  mushafId: string;
  /** How many body keys the set keeps shapes of. */
  bodyKeys: number;
  zoom: number;
  onOpenShape: (shape: LibraryShape) => void;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<LibraryKeyFilters | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLibraryKeys(mushafId, filters);
  const detail = useLibraryKey(mushafId, open);
  const change = (patch: Partial<LibraryKeyFilters>) =>
    setFilters((current) => ({ ...(current ?? FIRST_FILTERS), page: 1, ...patch }));
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.per_page)) : 1;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[13px] font-semibold text-ink">
        {t("calibration.library.keys.title", { count: bodyKeys })}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-3">{t("calibration.library.keys.letters")}</span>
        {[1, 2, 3, 4].map((count) => (
          <button
            key={count}
            type="button"
            className={CHIP}
            aria-pressed={filters?.letters === count}
            onClick={() => change({ letters: filters?.letters === count ? null : count })}
          >
            {count === 4 ? "4+" : count}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
          {t("calibration.library.keys.first")}
          <input
            dir="rtl"
            maxLength={1}
            className={cn(FIELD, "w-12 font-quran")}
            value={filters?.first ?? ""}
            onChange={(event) => change({ first: event.target.value.trim() })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
          {t("calibration.library.keys.contains")}
          <input
            dir="rtl"
            className={cn(FIELD, "font-quran")}
            value={filters?.contains ?? ""}
            onChange={(event) => change({ contains: event.target.value.trim() })}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-3">{t("calibration.library.keys.show")}</span>
        {(["all", "has", "none", "touching"] as const).map((show) => (
          <button
            key={show}
            type="button"
            className={CHIP}
            aria-pressed={filters?.show === show}
            onClick={() => change({ show })}
          >
            {t(`calibration.library.keys.shows.${show}`)}
          </button>
        ))}
        <span className="ms-2 text-[12.5px] text-ink-3">{t("calibration.library.keys.sort")}</span>
        {(["common", "fewest"] as const).map((sort) => (
          <button
            key={sort}
            type="button"
            className={CHIP}
            aria-pressed={filters?.sort === sort}
            onClick={() => change({ sort })}
          >
            {t(`calibration.library.keys.sorts.${sort}`)}
          </button>
        ))}
      </div>

      {filters === null && (
        <p className="text-[12.5px] text-ink-3">{t("calibration.library.keys.pick")}</p>
      )}
      {list.data && (
        <>
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            {t("calibration.library.keys.total", { count: list.data.total })}
            <span className="ms-auto flex items-center gap-1">
              <button
                type="button"
                className={CHIP}
                disabled={list.data.page <= 1}
                aria-label={t("calibration.library.keys.previous")}
                onClick={() => change({ page: list.data.page - 1 })}
              >
                <ChevronRight size={14} aria-hidden="true" className="rtl:rotate-180" />
              </button>
              {t("calibration.library.keys.page", { page: list.data.page, pages })}
              <button
                type="button"
                className={CHIP}
                disabled={list.data.page >= pages}
                aria-label={t("calibration.library.keys.next")}
                onClick={() => change({ page: list.data.page + 1 })}
              >
                <ChevronLeft size={14} aria-hidden="true" className="rtl:rotate-180" />
              </button>
            </span>
          </div>
          {list.data.keys.length === 0 && (
            <p className="text-[12.5px] text-ink-3">{t("calibration.library.keys.empty")}</p>
          )}
          <ul className="flex flex-col divide-y divide-rule">
            {list.data.keys.map((item) => (
              <li key={item.key} className="flex flex-col gap-2 py-2">
                <button
                  type="button"
                  className="flex items-center gap-3 text-start"
                  aria-expanded={open === item.key}
                  onClick={() => setOpen(open === item.key ? null : item.key)}
                >
                  <KeyName parts={item.parts} />
                  <span className="ms-auto font-mono text-[12px] text-ink-3">
                    {item.shapes
                      ? t("calibration.library.keys.shapes", { count: item.shapes })
                      : t("calibration.library.keys.noneYet")}
                    {" · "}
                    {t("calibration.library.keys.inText", { count: item.text_count })}
                  </span>
                </button>
                {open === item.key && detail.data && (
                  <div className="flex flex-wrap gap-2">
                    {detail.data.groups.flatMap((group) =>
                      [group.fingerprint, ...group.kept].map((shape) => (
                        <InkCell
                          key={shape.key}
                          data={shape.key}
                          imageUrl={shape.image_url}
                          imageSize={shape.image_size}
                          crop={shape.crop}
                          zoom={zoom}
                          title={t("calibration.library.from", {
                            page: shape.page_number,
                            line: shape.line_number,
                          })}
                          onOpen={() => onOpenShape(shape)}
                        />
                      )),
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

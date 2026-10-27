import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PageSummary } from "@/lib/api";

type SortKey = "page" | "lines" | "ayat" | "segments" | "status";
type Filter = "all" | "reviewed" | "processed";

export function PagesTab({
  mushafId,
  summaries,
  logical,
  remaining,
  abortPage,
}: {
  mushafId: string;
  summaries: PageSummary[] | undefined;
  logical: number;
  remaining: number;
  abortPage: number | null;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("page");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const rows = useMemo(() => {
    const all = summaries ?? [];
    const filtered = all.filter((s) =>
      filter === "all" ? true : filter === "reviewed" ? s.reviewed : !s.reviewed,
    );
    const value = (s: PageSummary) =>
      sortKey === "page" ? s.page_number : sortKey === "status" ? Number(s.reviewed) : s[sortKey];
    return filtered.slice().sort((a, b) => (value(a) - value(b)) * sortDir);
  }, [summaries, filter, sortKey, sortDir]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          lines: acc.lines + r.lines,
          ayat: acc.ayat + r.ayat,
          segments: acc.segments + r.segments,
        }),
        { lines: 0, ayat: 0, segments: 0 },
      ),
    [rows],
  );

  const all = summaries ?? [];
  const reviewedCount = all.filter((s) => s.reviewed).length;
  // The page Review would open next: the first one still to review.
  const nextPage = all.find((s) => !s.reviewed)?.page_number ?? null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  if (all.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-panel border border-rule bg-card px-6 py-14 text-center">
        <span className="font-display text-[20px] font-semibold">{t("details.pg_none")}</span>
        <span className="max-w-[420px] text-[13.5px] leading-normal text-ink-2">
          {t("details.pg_noneDesc")}
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="mt-1 inline-flex h-10 items-center rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis no-underline hover:bg-lapis/90"
        >
          {t("details.pg_goProcess")}
        </Link>
      </div>
    );
  }

  const chip = (active: boolean) =>
    `h-[34px] cursor-pointer rounded-pill px-[13px] text-[13px] transition-colors ${
      active
        ? "bg-ink font-semibold text-paper"
        : "border border-rule-2 bg-card font-medium text-ink-2 hover:border-ink-4"
    }`;
  const sortable = (key: SortKey, label: string, end = false) => (
    <th
      scope="col"
      aria-sort={sortKey === key ? (sortDir === 1 ? "ascending" : "descending") : undefined}
      className={`border-b border-rule px-3.5 py-3 ${end ? "text-end" : "text-start"}`}
    >
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="cursor-pointer text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3 hover:text-lapis-text"
      >
        {label}
        {sortKey === key && (sortDir === 1 ? " ↑" : " ↓")}
      </button>
    </th>
  );
  const plain = (label: string) => (
    <th
      scope="col"
      className="border-b border-rule px-3.5 py-3 text-start text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3"
    >
      {label}
    </th>
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="me-2 flex flex-col gap-0.5">
          <h2 className="m-0 font-display text-[24px] font-semibold">{t("details.pg_title")}</h2>
          <span className="text-[13px] text-ink-3">
            {t("hub.pagesSub", { processed: all.length, total: logical })}{" "}
            {t("details.pg_remaining", { count: remaining })}
          </span>
        </div>
        <div role="group" aria-label={t("hub.filterPages")} className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
            className={chip(filter === "all")}
          >
            {t("details.pg_all", { count: all.length })}
          </button>
          <button
            type="button"
            aria-pressed={filter === "reviewed"}
            onClick={() => setFilter("reviewed")}
            className={chip(filter === "reviewed")}
          >
            {t("details.pg_reviewed", { count: reviewedCount })}
          </button>
          <button
            type="button"
            aria-pressed={filter === "processed"}
            onClick={() => setFilter("processed")}
            className={chip(filter === "processed")}
          >
            {t("details.pg_processed", { count: all.length - reviewedCount })}
          </button>
        </div>
        {abortPage && (
          <Link
            to="/mushafs/$mushafId/process"
            params={{ mushafId }}
            className="ms-auto inline-flex h-[38px] items-center rounded-control bg-lapis px-3.5 text-[13.5px] font-semibold text-on-lapis no-underline hover:bg-lapis/90"
          >
            {t("details.pg_resume", { page: abortPage })}
          </Link>
        )}
      </div>

      <div className="overflow-x-auto rounded-panel border border-rule bg-card">
        <table className="w-full min-w-[760px] border-collapse text-[14px]">
          <thead className="sticky top-0 z-[1] bg-sheet">
            <tr>
              {sortable("page", t("details.col_page"))}
              {plain(t("details.col_pdf"))}
              {plain(t("details.col_sura"))}
              {sortable("lines", t("details.col_lines"), true)}
              {sortable("ayat", t("details.col_ayat"), true)}
              {sortable("segments", t("details.col_segs"), true)}
              {sortable("status", t("details.col_status"))}
              <th scope="col" className="border-b border-rule px-[18px] py-3">
                <span className="sr-only">{t("details.pg_open")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PageRow
                key={row.page_number}
                row={row}
                mushafId={mushafId}
                next={row.page_number === nextPage}
              />
            ))}
          </tbody>
          <tfoot className="bg-sheet">
            <tr>
              <td colSpan={3} className="px-[18px] py-3 text-[13px] text-ink-3">
                {t("details.pg_sigma", { count: rows.length })}
              </td>
              <td className="px-3.5 py-3 text-end font-mono font-semibold">{totals.lines}</td>
              <td className="px-3.5 py-3 text-end font-mono font-semibold">{totals.ayat}</td>
              <td className="px-3.5 py-3 text-end font-mono font-semibold">{totals.segments}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function PageRow({ row, mushafId, next }: { row: PageSummary; mushafId: string; next: boolean }) {
  const { t } = useTranslation();
  const firstSura = row.suras[0];
  const status = row.reviewed
    ? { label: t("details.status_reviewed"), chip: "bg-done-wash text-done-text", dot: "bg-done" }
    : next
      ? { label: t("hub.statusNext"), chip: "bg-gold-wash text-ink", dot: "bg-gold" }
      : {
          label: t("details.status_processed"),
          chip: "bg-lapis-wash text-lapis-text",
          dot: "bg-lapis",
        };
  const cell = "border-b border-rule-soft px-3.5 py-[11px]";
  return (
    <tr className={next ? "bg-gold-wash" : "transition-colors hover:bg-sheet"}>
      <td className={`${cell} ps-[18px] font-mono font-semibold`}>{row.page_number}</td>
      <td className={`${cell} font-mono text-ink-3`}>{row.source_pdf_page}</td>
      <td className={cell}>
        <span className="inline-flex flex-wrap items-center gap-2">
          {firstSura ? (
            <>
              <span>{firstSura.transliteration}</span>
              <span dir="rtl" className="font-cite text-[15px] leading-none text-ink-2">
                {firstSura.name_arabic}
              </span>
              {row.suras.length > 1 && (
                <span className="text-[12px] text-ink-3">+{row.suras.length - 1}</span>
              )}
            </>
          ) : (
            <span className="text-ink-3">—</span>
          )}
          {row.has_header && (
            <span className="rounded-[4px] bg-gold-wash px-[7px] py-px text-[11.5px] font-semibold text-gold-text">
              {t("details.pg_header")}
            </span>
          )}
        </span>
      </td>
      <td className={`${cell} text-end font-mono`}>{row.lines}</td>
      <td className={`${cell} text-end font-mono`}>{row.ayat}</td>
      <td className={`${cell} text-end font-mono`}>{row.segments}</td>
      <td className={cell}>
        <span
          className={`inline-flex items-center gap-1.5 rounded-pill px-[9px] py-[3px] text-[12px] font-semibold ${status.chip}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </td>
      <td className={`${cell} pe-[18px] text-end`}>
        <Link
          to="/mushafs/$mushafId/review"
          params={{ mushafId }}
          search={{ page: row.page_number }}
          className="whitespace-nowrap text-[13px] font-semibold text-lapis-text no-underline hover:text-lapis-text/80"
        >
          {t("details.pg_open")}
        </Link>
      </td>
    </tr>
  );
}

import { Link } from "@tanstack/react-router";
import { FileStack } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, STATE_PRIMARY } from "@/components/app/States";
import type { PageSummary } from "@/lib/api";
import type { CalibrationPageState } from "@/lib/calibration/types";

import {
  findDoneStages,
  findInkProcessedPages,
  PAGE_STAGES,
  rankDoneStages,
  type PageStageKey,
} from "./pageStages";

type SortKey = "page" | "lines" | "ayat" | "segments" | "status";
/** The pages that have done one stage. Every listed page is processed, so
 * "processed" is the whole list. */
type Filter = PageStageKey;
type StagedPage = { row: PageSummary; done: Set<PageStageKey> };

export function PagesTab({
  mushafId,
  summaries,
  calibrationPages,
  logical,
  remaining,
  abortPage,
}: {
  mushafId: string;
  summaries: PageSummary[] | undefined;
  calibrationPages: CalibrationPageState[] | undefined;
  logical: number;
  remaining: number;
  abortPage: number | null;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("processed");
  const [sortKey, setSortKey] = useState<SortKey>("page");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const staged: StagedPage[] = useMemo(() => {
    const inkPages = findInkProcessedPages(calibrationPages);
    return (summaries ?? []).map((row) => ({
      row,
      done: findDoneStages(row, inkPages.has(row.page_number)),
    }));
  }, [summaries, calibrationPages]);

  const rows = useMemo(() => {
    const value = ({ row, done }: StagedPage) =>
      sortKey === "page"
        ? row.page_number
        : sortKey === "status"
          ? rankDoneStages(done)
          : row[sortKey];
    return staged
      .filter(({ done }) => done.has(filter))
      .sort((a, b) => (value(a) - value(b)) * sortDir);
  }, [staged, filter, sortKey, sortDir]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, { row }) => ({
          lines: acc.lines + row.lines,
          ayat: acc.ayat + row.ayat,
          segments: acc.segments + row.segments,
        }),
        { lines: 0, ayat: 0, segments: 0 },
      ),
    [rows],
  );

  const all = summaries ?? [];
  // Each stage counted on its own: a reviewed page is a processed page too.
  const counts = Object.fromEntries(
    PAGE_STAGES.map((stage) => [
      stage.key,
      staged.filter(({ done }) => done.has(stage.key)).length,
    ]),
  ) as Record<PageStageKey, number>;
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
      <EmptyState
        icon={<FileStack size={28} strokeWidth={1.6} aria-hidden="true" />}
        title={t("details.pg_none")}
        body={t("details.pg_noneDesc")}
      >
        <Link to="/mushafs/$mushafId/process" params={{ mushafId }} className={STATE_PRIMARY}>
          {t("details.pg_goProcess")}
        </Link>
      </EmptyState>
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
          {PAGE_STAGES.map((stage) => (
            <button
              key={stage.key}
              type="button"
              aria-pressed={filter === stage.key}
              onClick={() => setFilter(stage.key)}
              className={chip(filter === stage.key)}
            >
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${stage.fill}`} />
                {t(stage.label)} · {counts[stage.key].toLocaleString()}
              </span>
            </button>
          ))}
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
            {rows.map(({ row, done }) => (
              <PageRow
                key={row.page_number}
                row={row}
                done={done}
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

function PageRow({
  row,
  done,
  mushafId,
  next,
}: {
  row: PageSummary;
  done: Set<PageStageKey>;
  mushafId: string;
  next: boolean;
}) {
  const { t } = useTranslation();
  const firstSura = row.suras[0];
  const doneLabel = PAGE_STAGES.filter((stage) => done.has(stage.key))
    .map((stage) => t(stage.label))
    .join(" · ");
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
        <span className="inline-flex items-center gap-2.5">
          {/* One bar per stage, in pipeline order, as on the coverage map. */}
          <span
            role="img"
            aria-label={doneLabel}
            title={doneLabel}
            className="inline-flex gap-[3px]"
          >
            {PAGE_STAGES.map((stage) => (
              <span
                key={stage.key}
                className={`h-1.5 w-4 rounded-full ${done.has(stage.key) ? stage.fill : "bg-sunk"}`}
              />
            ))}
          </span>
          {next && (
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-gold-wash px-[9px] py-[3px] text-[12px] font-semibold text-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-gold" />
              {t("hub.statusNext")}
            </span>
          )}
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

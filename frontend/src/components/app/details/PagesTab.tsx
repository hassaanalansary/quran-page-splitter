import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { PageSummary } from "@/lib/api";

type SortKey = "page" | "lines" | "ayat" | "segments" | "status";
type Filter = "all" | "reviewed" | "processed";

const GRID = "grid grid-cols-[1fr_1fr_4fr_1fr_1fr_1fr_1fr_1fr]";

export function PagesTab({
  mushafId,
  summaries,
  remaining,
  abortPage,
}: {
  mushafId: string;
  summaries: PageSummary[] | undefined;
  remaining: number;
  abortPage: number | null;
}) {
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

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }
  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 1 ? " ↑" : " ↓") : "");

  if (all.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[11px] border border-border bg-white px-6 py-14 text-center">
        <span className="text-[13px] font-semibold text-text-primary">No pages processed yet</span>
        <span className="max-w-[380px] text-[11.5px] leading-[1.6] text-text-secondary">
          Run the pipeline from the Process step — each processed page appears here with its
          detected lines, ayat and segments.
        </span>
        <Link
          to="/mushafs/$mushafId/process"
          params={{ mushafId }}
          className="mt-1 rounded-lg bg-navy px-4 py-2 text-[12px] font-bold text-white transition-colors hover:bg-navy-hover"
        >
          Go to Process →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11.5px] font-bold text-text-primary">Processed pages</span>
        <span className="text-[11.5px] text-text-muted">
          · {remaining} remaining · sort by any column
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label={`All · ${all.length}`}
          />
          <FilterChip
            active={filter === "reviewed"}
            onClick={() => setFilter("reviewed")}
            label={`Reviewed · ${reviewedCount}`}
          />
          <FilterChip
            active={filter === "processed"}
            onClick={() => setFilter("processed")}
            label={`Processed · ${all.length - reviewedCount}`}
          />
          {abortPage && (
            <Link
              to="/mushafs/$mushafId/process"
              params={{ mushafId }}
              className="ml-1 rounded-[7px] bg-orange-tint px-[11px] py-1 text-[10.5px] font-bold text-orange transition-colors hover:bg-orange-glow"
            >
              Resume p.{abortPage} →
            </Link>
          )}
        </div>
      </div>

      {/* table */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[11px] border border-border bg-white">
        <div className="flex-1 overflow-auto">
          <div className={`${GRID} sticky top-0 z-10 border-b border-border bg-bg-surface`}>
            <HeaderButton label="Page" arrow={arrow("page")} onClick={() => toggleSort("page")} />
            <HeaderCell label="PDF" />
            <HeaderCell label="Sura" />
            <HeaderButton
              label="Lines"
              arrow={arrow("lines")}
              onClick={() => toggleSort("lines")}
            />
            <HeaderButton label="Ayat" arrow={arrow("ayat")} onClick={() => toggleSort("ayat")} />
            <HeaderButton
              label="Segs"
              arrow={arrow("segments")}
              onClick={() => toggleSort("segments")}
            />
            <HeaderButton
              label="Status"
              arrow={arrow("status")}
              onClick={() => toggleSort("status")}
            />
            <div className="px-3 py-[9px]" />
          </div>
          {rows.map((row, i) => (
            <PageRow key={row.page_number} row={row} mushafId={mushafId} zebra={i % 2 === 1} />
          ))}
        </div>
        {/* totals footer */}
        <div className={`${GRID} shrink-0 border-t border-border bg-bg-surface`}>
          <div className="col-span-3 px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
            Σ · {rows.length} pages in view
          </div>
          <div className="px-3 py-2 text-center font-mono text-[12px] font-bold font-semibold text-text-primary">
            {totals.lines}
          </div>
          <div className="px-3 py-2 text-center font-mono text-[12px] font-bold font-semibold text-text-primary">
            {totals.ayat}
          </div>
          <div className="px-3 py-2 text-center font-mono text-[12px] font-bold font-semibold text-text-muted">
            {totals.segments}
          </div>
          <div className="col-span-2" />
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-[7px] border px-2.5 py-1 text-[10.5px] font-semibold transition ${
        active
          ? "border-navy bg-navy text-white"
          : "border-border bg-white text-text-secondary hover:border-border-strong"
      }`}
    >
      {label}
    </button>
  );
}

function HeaderCell({ label }: { label: string }) {
  return (
    <div className="flex items-center px-3 py-[9px] text-[12px] font-semibold uppercase tracking-[0.07em] text-text-secondary">
      {label}
    </div>
  );
}

function HeaderButton({
  label,
  arrow,
  onClick,
  right,
}: {
  label: string;
  arrow: string;
  onClick: () => void;
  right?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex cursor-pointer items-center justify-center px-3 py-[9px] text-[12px] font-semibold uppercase tracking-[0.07em] text-text-secondary transition-colors hover:text-navy ${right ? "justify-end" : ""}`}
    >
      {label}
      <span className="font-bold text-orange">{arrow}</span>
    </button>
  );
}

function PageRow({ row, mushafId, zebra }: { row: PageSummary; mushafId: string; zebra: boolean }) {
  const firstSura = row.suras[0];
  return (
    <div
      className={`${GRID} items-center border-t border-border transition-colors hover:bg-orange-tint ${
        zebra ? "bg-[oklch(0.985_0.004_247)]" : "bg-white"
      }`}
    >
      <div className="px-3 py-2 font-mono text-[12px] font-bold text-text-primary">
        {String(row.page_number).padStart(2, "0")}
      </div>
      <div className="px-3 py-2 font-mono text-[11px] font-medium text-text-muted">
        p.{row.source_pdf_page}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-3 py-[5px]">
        {firstSura ? (
          <>
            <span className="whitespace-nowrap text-[11.5px] font-medium text-text-primary">
              {firstSura.transliteration}
            </span>
            <span dir="rtl" className="font-arabic text-[13px] leading-none text-text-secondary">
              {firstSura.name_arabic}
            </span>
            {row.suras.length > 1 && (
              <span className="text-[10px] text-text-muted">+{row.suras.length - 1}</span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-text-muted">—</span>
        )}
        {row.has_header && (
          <span className="flex-none rounded-[9px] bg-orange-tint px-[5px] py-px text-[8.5px] font-semibold uppercase tracking-[0.04em] text-orange">
            header
          </span>
        )}
      </div>
      <div className="px-3 py-2 text-center font-mono text-[11.5px] font-medium text-text-primary">
        {row.lines}
      </div>
      <div className="px-3 py-2 text-center font-mono text-[11.5px] font-medium text-text-primary">
        {row.ayat}
      </div>
      <div className="px-3 py-2 text-center font-mono text-[11.5px] font-medium text-text-muted">
        {row.segments}
      </div>
      <div className="flex items-center justify-center gap-1.5 px-3 py-2">
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{ background: row.reviewed ? "var(--success)" : "var(--navy-light)" }}
        />
        <span className="text-[11px] font-medium text-text-secondary">
          {row.reviewed ? "Reviewed" : "Processed"}
        </span>
      </div>
      <div className="px-3 py-2 text-right">
        <Link
          to="/mushafs/$mushafId/review"
          params={{ mushafId }}
          search={{ page: row.page_number }}
          className="whitespace-nowrap text-[11px] font-semibold text-orange hover:text-orange-hover"
        >
          Open →
        </Link>
      </div>
    </div>
  );
}

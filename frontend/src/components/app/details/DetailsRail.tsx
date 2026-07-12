import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  pageImageUrl,
  type MushafDetail,
  type MushafStats,
  type PageSummary,
  type Template,
} from "@/lib/api";

import { fmtDate, humanSize, shortId } from "./helpers";

/** Left rail: identity, progress, stat trio, templates, record, coverage map. */
export function DetailsRail({
  mushaf,
  stats,
  summaries,
  templates,
}: {
  mushaf: MushafDetail;
  stats: MushafStats | undefined;
  summaries: PageSummary[] | undefined;
  templates: Template[] | undefined;
}) {
  const { t } = useTranslation();
  const [openTemplate, setOpenTemplate] = useState<Template | undefined>(undefined);
  const logical = mushaf.logical_page_count;
  const processed = mushaf.processed_page_count;
  const reviewed = mushaf.reviewed_page_count;

  function showTemplateDialog(template: Template | undefined) {
    if (!templates || templates.length === 0) return;
    setOpenTemplate(template);
  }

  return (
    <div className="flex w-[282px] flex-shrink-0 flex-col gap-4 overflow-y-auto border-s border-border bg-white p-4 pb-[18px]">
      {/* identity */}
      <div className="flex items-start gap-3">
        <Cover mushaf={mushaf} />
        <div className="min-w-0 pt-0.5">
          <div className="font-display text-[16px] font-extrabold leading-none text-navy">
            {mushaf.name}
          </div>
          <div className="mt-2 text-[10.5px] font-medium leading-[1.45] text-text-secondary">
            {mushaf.qiraa ? (
              <span className="capitalize">{mushaf.qiraa}</span>
            ) : (
              t("details.rail_noQiraa")
            )}
            {mushaf.counting_system && (
              <>
                <br />
                <span className="text-text-muted">
                  {t("details.rail_counting", {
                    name: mushaf.counting_system.name,
                    total: mushaf.counting_system.total_ayat,
                  })}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* progress bars */}
      <div className="flex flex-col gap-[11px]">
        <ProgressRow
          label={t("details.rail_processed")}
          value={processed}
          total={logical}
          color="var(--navy-light)"
        />
        <ProgressRow
          label={t("details.rail_reviewed")}
          value={reviewed}
          total={logical}
          color="var(--orange)"
        />
      </div>

      {/* stat trio */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <StatCell value={stats?.ayat_found} label={t("details.rail_ayat")} />
        <StatCell value={stats?.lines_cut} label={t("details.rail_lines")} />
        <StatCell value={stats?.exported_pngs} label={t("details.rail_pngs")} muted />
      </div>

      {/* templates */}
      <div className="border-t border-border pt-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-muted">
            {t("details.rail_templates")}
          </span>
          <Link
            to="/mushafs/$mushafId/templates"
            params={{ mushafId: mushaf.id }}
            className="text-[10px] font-semibold text-orange hover:text-orange-hover"
          >
            {t("details.rail_edit")}
          </Link>
        </div>
        <TemplateRow
          label={t("details.rail_suraHeader")}
          template={templates?.find((t) => t.type === "sura_header")}
          onClick={() => showTemplateDialog(templates?.find((t) => t.type === "sura_header"))}
        />
        <TemplateRow
          label={t("details.rail_ayaSeparator")}
          template={templates?.find((t) => t.type === "aya_separator")}
          onClick={() => showTemplateDialog(templates?.find((t) => t.type === "aya_separator"))}
        />
      </div>

      {/* record */}
      <div className="flex flex-col gap-[7px] border-t border-border pt-3">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-muted">
          {t("details.rail_record")}
        </div>
        <RecordRow
          label={t("details.rail_quranRange")}
          value={t("details.rail_quranRangeValue", {
            first: mushaf.first_quran_pdf_page,
            last: mushaf.last_quran_pdf_page,
          })}
        />
        <RecordRow label={t("details.rail_logicalPages")} value={String(logical)} />
        <RecordRow label={t("details.rail_file")} value={mushaf.pdf_original_name || "—"} />
        <RecordRow label={t("details.rail_size")} value={humanSize(mushaf.pdf_file_size)} />
        <RecordRow label={t("details.rail_uploaded")} value={fmtDate(mushaf.created_at)} />
        <RecordRow label={t("details.rail_id")} value={shortId(mushaf.id)} muted />
      </div>

      {/* coverage map */}
      <div className="mt-auto border-t border-border pt-3">
        <div className="mb-[9px] flex items-baseline justify-between">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-muted">
            {t("details.rail_coverage")}
          </span>
          <span className="font-mono text-[10px] font-semibold text-text-muted">
            {processed}/{logical}
          </span>
        </div>
        <CoverageMap mushafId={mushaf.id} logical={logical} summaries={summaries} />
        <div className="mt-[9px] flex gap-2.5 text-[9.5px] text-text-secondary">
          <LegendDot color="var(--success)" label={t("details.rail_reviewed")} />
          <LegendDot color="var(--orange)" label={t("details.rail_processed")} />
          <LegendDot color="var(--bg-muted)" label={t("details.rail_todo")} />
        </div>
      </div>
      {openTemplate && (
        <TemplateModal template={openTemplate} onClose={() => setOpenTemplate(undefined)} />
      )}
    </div>
  );
}

function Cover({ mushaf }: { mushaf: MushafDetail }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex h-[82px] w-[58px] flex-shrink-0 items-center justify-center rounded border border-border-strong bg-bg-muted text-[9px] text-text-muted">
        {t("details.rail_noCover")}
      </div>
    );
  }
  return (
    <img
      src={mushaf.thumbnail_url ?? pageImageUrl(mushaf.id, 1, mushaf.updated_at)}
      alt={t("details.rail_coverAlt", { name: mushaf.name })}
      draggable={false}
      onError={() => setFailed(true)}
      className="h-[82px] w-[58px] flex-shrink-0 rounded border border-border-strong object-cover shadow-[var(--shadow-sm)]"
    />
  );
}

function ProgressRow({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
          {label}
        </span>
        <span className="font-mono text-[12px] font-bold text-text-primary">
          {value}
          <span className="font-medium text-text-muted">/{total}</span>
        </span>
      </div>
      <div className="mt-[5px] h-[5px] overflow-hidden rounded-[3px] bg-bg-muted">
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function StatCell({
  value,
  label,
  muted,
}: {
  value: number | undefined;
  label: string;
  muted?: boolean;
}) {
  return (
    <div className="bg-white px-2.5 py-[9px]">
      <div
        className={`font-mono text-[16px] font-bold ${muted ? "text-text-muted" : "text-text-primary"}`}
      >
        {value ?? "…"}
      </div>
      <div className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.05em] text-text-secondary">
        {label}
      </div>
    </div>
  );
}

function TemplateRow({
  label,
  template,
  onClick,
}: {
  label: string;
  template: Template | undefined;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="mb-[7px] flex items-center gap-2 last:mb-0 cursor-zoom-in hover:opacity-80"
      onClick={onClick}
    >
      {template ? (
        <img
          src={template.image_url}
          alt={t("details.rail_templateAlt", { label })}
          className="h-16 min-w-0 flex-1 rounded-[5px] border border-border-strong bg-white object-contain"
        />
      ) : (
        <span className="flex h-[30px] min-w-0 flex-1 items-center justify-center rounded-[5px] border border-dashed border-border-strong text-[9.5px] text-text-muted">
          {t("details.rail_notCaptured")}
        </span>
      )}
      <span className="w-[118px] flex-none text-[10.5px] font-medium text-text-secondary">
        {label}{" "}
        {template ? (
          <span className="font-bold text-success">✓</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </span>
    </div>
  );
}

function RecordRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[11px] font-medium text-text-secondary">{label}</span>
      <span
        className={`truncate font-mono text-[11px] font-semibold ${muted ? "text-text-muted" : "text-text-primary"}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function CoverageMap({
  mushafId,
  logical,
  summaries,
}: {
  mushafId: string;
  logical: number;
  summaries: PageSummary[] | undefined;
}) {
  const { t } = useTranslation();
  const byPage = new Map((summaries ?? []).map((s) => [s.page_number, s]));
  return (
    <div
      className="flex flex-wrap gap-[2px]"
      role="img"
      aria-label={t("details.rail_coverageAria")}
    >
      {Array.from({ length: logical }, (_, i) => {
        const n = i + 1;
        const row = byPage.get(n);
        const bg = row ? (row.reviewed ? "var(--success)" : "var(--orange)") : "var(--bg-muted)";
        const state = row
          ? row.reviewed
            ? t("details.state_reviewed")
            : t("details.state_processed")
          : t("details.state_notProcessed");
        return (
          <div key={n} className="group relative">
            <Link
              to="/mushafs/$mushafId/review"
              params={{ mushafId }}
              search={{ page: n }}
              className="block h-[6px] w-[6px] rounded-[1px]"
              style={{ background: bg }}
            />
            <p className="pointer-events-none absolute bottom-full left-1/2 z-[1000] mb-1 -translate-x-1/2 whitespace-nowrap rounded border border-gray-300 bg-black px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
              {t("details.rail_pageState", { n, state })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-[6px] w-[6px] rounded-[1px]" style={{ background: color }} />
      {label}
    </span>
  );
}

function TemplateModal({
  template,
  onClose,
}: {
  template: Template | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!template) return null;
  const typeLabel = t(
    template.type === "sura_header" ? "details.rail_suraHeader" : "details.rail_ayaSeparator",
  );
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] max-w-[90vw] min-w-[300px] flex flex-col overflow-auto rounded-lg bg-white p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-text-primary capitalize">{typeLabel}</span>
          <button
            onClick={onClose}
            className="text-lg font-bold text-text-muted hover:text-text-primary"
            aria-label={t("details.rail_closeModal")}
          >
            ✕
          </button>
        </div>
        <img
          src={template.image_url}
          alt={t("details.rail_templateAlt", { label: typeLabel })}
          className="max-h-[80vh] max-w-[80vw] object-contain"
        />
      </div>
    </div>
  );
}

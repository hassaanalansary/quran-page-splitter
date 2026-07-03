// Shared formatting + derivation helpers for the mushaf details page.
import type {
  ActivityEvent,
  MushafDetail,
  MushafStats,
  MushafStatus,
  PageSummary,
  Run,
} from "@/lib/api";

// ── Status pill (top chrome) ─────────────────────────────────────────────────
export const STATUS_META: Record<MushafStatus, { label: string; dot: string }> = {
  empty: { label: "Not processed", dot: "var(--text-muted)" },
  partial: { label: "In progress", dot: "var(--warning)" },
  processed: { label: "Processed", dot: "var(--navy-light)" },
  completed: { label: "Completed", dot: "var(--success)" },
};

// ── Formatting ───────────────────────────────────────────────────────────────
/** "30 Jun 14:22" */
export function fmtDayTime(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/** "28 Jun 2026" */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** "61.4 MB" */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** "3f9a…c721" */
export function shortId(id: string): string {
  const hex = id.replace(/-/g, "");
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

export function runNumberLabel(n: number): string {
  return `#${String(n).padStart(2, "0")}`;
}

// ── Runs ─────────────────────────────────────────────────────────────────────
/** Logical page a run aborted on (from the stored engine abort detail), or null. */
export function runAbortPage(run: Run): number | null {
  const index = run.abort_info?.["page_index"];
  return typeof index === "number" ? run.page_range_start + index : null;
}

export const RUN_STATUS_META: Record<
  string,
  { label: string; dot: string; bg: string; text: string }
> = {
  completed: {
    label: "Completed",
    dot: "var(--success)",
    bg: "bg-success-bg",
    text: "text-success",
  },
  aborted_line_detection: {
    label: "Aborted · line mismatch",
    dot: "var(--warning)",
    bg: "bg-warning-bg",
    text: "text-[#8a4b0d]",
  },
  error: { label: "Error", dot: "var(--error)", bg: "bg-error-bg", text: "text-error" },
};

/** The five run settings the design surfaces, in display order. */
export const RUN_SETTING_ROWS: { key: string; label: string }[] = [
  { key: "expected_lines", label: "expected_lines" },
  { key: "match_threshold", label: "match_threshold" },
  { key: "sura_header_threshold", label: "header_threshold" },
  { key: "padding", label: "padding" },
  { key: "max_sura_headers", label: "max_headers" },
];

// ── Activity feed ────────────────────────────────────────────────────────────
export function activityMeta(event: ActivityEvent): { dot: string; text: string } {
  const p = event.payload as Record<string, string | number | undefined>;
  switch (event.type) {
    case "mushaf_created":
      return { dot: "var(--text-muted)", text: `${p.pdf_original_name || "PDF"} uploaded` };
    case "bounds_set":
      return { dot: "var(--navy-light)", text: `Quran bounds set — pp.${p.first}–${p.last}` };
    case "template_saved":
      return {
        dot: "var(--success)",
        text: `${p.template_type === "aya_separator" ? "Aya-separator" : "Sura-header"} template saved`,
      };
    case "run_finished": {
      const num = runNumberLabel(Number(p.run_number ?? 0));
      if (p.status === "completed") {
        return {
          dot: "var(--success)",
          text: `Run ${num} completed (pp.${p.page_range_start}–${p.page_range_end})`,
        };
      }
      if (p.status === "aborted_line_detection") {
        const where = p.abort_page ? ` at p.${p.abort_page}` : "";
        return { dot: "var(--warning)", text: `Run ${num} aborted — line mismatch${where}` };
      }
      return { dot: "var(--error)", text: `Run ${num} failed` };
    }
    case "review_saved":
      return {
        dot: "var(--orange)",
        text:
          p.page_start != null
            ? `Review saved — pages ${p.page_start}–${p.page_end} (${p.count})`
            : `Review saved — page ${p.page_number}`,
      };
    case "lines_exported":
      return {
        dot: "var(--navy-light)",
        text: `Line PNGs exported — page ${p.page_number} (${p.exported} lines)`,
      };
    default:
      return { dot: "var(--text-muted)", text: event.type };
  }
}

// ── Pipeline derivation ──────────────────────────────────────────────────────
export type StepSlug = "setup" | "templates" | "process" | "review" | "finalize";

export type StepInfo = {
  slug: StepSlug;
  label: string;
  state: "done" | "active" | "todo";
  detail: string;
  /** Render the detail line in the warning tone (aborted run). */
  warn?: boolean;
};

export function pipelineSteps(
  mushaf: MushafDetail,
  templatesReady: boolean,
  stats: MushafStats | undefined,
  abortPage: number | null,
): StepInfo[] {
  const logical = mushaf.logical_page_count;
  const processed = mushaf.processed_page_count;
  const reviewed = mushaf.reviewed_page_count;
  const exported = stats?.exported_pngs ?? 0;
  const linesCut = stats?.lines_cut ?? 0;

  const process: StepInfo =
    processed === 0
      ? { slug: "process", label: "Process", state: "todo", detail: `0 / ${logical} pages` }
      : processed >= logical
        ? {
            slug: "process",
            label: "Process",
            state: "done",
            detail: `${processed} / ${logical} pages`,
          }
        : {
            slug: "process",
            label: "Process",
            state: "active",
            detail: `${processed} / ${logical}${abortPage ? " · abort" : ""}`,
            warn: !!abortPage,
          };

  const review: StepInfo =
    processed === 0
      ? { slug: "review", label: "Review", state: "todo", detail: "awaiting pages" }
      : reviewed >= processed
        ? {
            slug: "review",
            label: "Review",
            state: "done",
            detail: `${reviewed} / ${processed} pages`,
          }
        : {
            slug: "review",
            label: "Review",
            state: "active",
            detail: `${reviewed} / ${processed} pages`,
          };

  const finalize: StepInfo =
    exported === 0
      ? { slug: "finalize", label: "Finalize", state: "todo", detail: "0 PNGs out" }
      : exported >= linesCut && linesCut > 0
        ? { slug: "finalize", label: "Finalize", state: "done", detail: `${exported} PNGs out` }
        : {
            slug: "finalize",
            label: "Finalize",
            state: "active",
            detail: `${exported} / ${linesCut} PNGs`,
          };

  return [
    {
      slug: "setup",
      label: "Setup",
      state: "done",
      detail: `Range pp.${mushaf.first_quran_pdf_page}–${mushaf.last_quran_pdf_page}`,
    },
    {
      slug: "templates",
      label: "Templates",
      state: templatesReady ? "done" : "active",
      detail: templatesReady ? "Header + separator" : "capture both",
    },
    process,
    review,
    finalize,
  ];
}

/** Where "Continue →" should land, with its two-line CTA sublabel. */
export function continueTarget(
  mushaf: MushafDetail,
  templatesReady: boolean,
  summaries: PageSummary[] | undefined,
  stats: MushafStats | undefined,
): { slug: StepSlug; sub: string; reviewPage?: number } {
  const processed = mushaf.processed_page_count;
  const reviewed = mushaf.reviewed_page_count;
  if (!templatesReady && processed === 0) return { slug: "setup", sub: "Setup · mark Quran range" };
  if (!templatesReady) return { slug: "templates", sub: "Templates · capture both" };
  if (processed === 0) return { slug: "process", sub: `Process · 0/${mushaf.logical_page_count}` };
  if (reviewed < processed) {
    const firstUnreviewed = summaries?.find((s) => !s.reviewed)?.page_number ?? reviewed + 1;
    return {
      slug: "review",
      sub: `Review · p.${firstUnreviewed}/${processed}`,
      reviewPage: firstUnreviewed,
    };
  }
  const exported = stats?.exported_pngs ?? 0;
  return { slug: "finalize", sub: `Finalize · ${exported} PNGs out` };
}

export const STEP_ROUTES = {
  setup: "/mushafs/$mushafId/setup",
  templates: "/mushafs/$mushafId/templates",
  process: "/mushafs/$mushafId/process",
  review: "/mushafs/$mushafId/review",
  finalize: "/mushafs/$mushafId/finalize",
} as const satisfies Record<StepSlug, string>;

// Shared formatting + derivation helpers for the mushaf details page.
import i18n from "@/i18n/config";
import type {
  TemplateType,
  ActivityEvent,
  MushafDetail,
  MushafStats,
  MushafStatus,
  PageSummary,
  Rect,
  Run,
  WordCoverage,
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
/** Logical page a run aborted on (from the stored engine abort detail), or null.
 *
 * `page_index` is 1-BASED within the batch (core/pipeline.py enumerates from 1),
 * so the first page of the range is index 1 — hence the -1. */
export function runAbortPage(run: Run): number | null {
  const index = run.abort_info?.["page_index"];
  return typeof index === "number" ? run.page_range_start + index - 1 : null;
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
  running: { label: "Running", dot: "var(--orange)", bg: "bg-bg-surface", text: "text-orange" },
  cancelled: {
    label: "Stopped",
    dot: "var(--text-muted)",
    bg: "bg-bg-surface",
    text: "text-text-secondary",
  },
  // A row left `running` by a crash or a server restart, settled after the fact.
  interrupted: {
    label: "Interrupted",
    dot: "var(--text-muted)",
    bg: "bg-bg-surface",
    text: "text-text-secondary",
  },
  error: { label: "Error", dot: "var(--error)", bg: "bg-error-bg", text: "text-error" },
};

/** i18n key for a run's status chip (unknown statuses read as an error).
 * Returns literal types, not `string`, so `t()` keeps its key checking. */
export function runStatusKey(status: string) {
  switch (status) {
    case "completed":
      return "details.runStatus_completed" as const;
    case "aborted_line_detection":
      return "details.runStatus_aborted" as const;
    case "running":
      return "details.runStatus_running" as const;
    case "cancelled":
      return "details.runStatus_cancelled" as const;
    case "interrupted":
      return "details.runStatus_interrupted" as const;
    default:
      return "details.runStatus_error" as const;
  }
}

const fmtBool = (v: unknown): string =>
  v ? i18n.t("details.bool_on") : i18n.t("details.bool_off");
const fmtNum = (v: unknown): string => (v == null ? "—" : String(v));

/** Every setting a run captured, as readable label/value rows for the run card
 * (range + start position + bounds + detection settings, in display order). */
export function runSettingsRows(run: Run): { label: string; value: string }[] {
  const s = run.settings;
  const b = s.bounds as Rect | undefined;
  return [
    {
      label: i18n.t("details.row_range"),
      value: `pp. ${run.page_range_start}–${run.page_range_end}`,
    },
    { label: i18n.t("details.row_start"), value: `${fmtNum(s.start_sura)}:${fmtNum(s.start_aya)}` },
    {
      label: i18n.t("details.row_bounds"),
      value:
        b && typeof b.w === "number"
          ? `${Math.round(b.w)}×${Math.round(b.h)} @ ${Math.round(b.x)},${Math.round(b.y)}`
          : "—",
    },
    { label: i18n.t("details.row_expected_lines"), value: fmtNum(s.expected_lines) },
    { label: i18n.t("details.row_match_threshold"), value: fmtNum(s.match_threshold) },
    { label: i18n.t("details.row_header_threshold"), value: fmtNum(s.sura_header_threshold) },
    { label: i18n.t("details.row_header_slots"), value: fmtNum(s.sura_header_slots) },
    { label: i18n.t("details.row_max_headers"), value: fmtNum(s.max_sura_headers) },
    { label: i18n.t("details.row_padding"), value: fmtNum(s.padding) },
    { label: i18n.t("details.row_alt_margins"), value: fmtBool(s.alternate_horizontal_margin) },
    { label: i18n.t("details.row_acceleration"), value: fmtBool(s.prefer_acceleration) },
  ];
}

// ── Activity feed ────────────────────────────────────────────────────────────
export function activityMeta(event: ActivityEvent): { dot: string; text: string } {
  const p = event.payload as Record<string, string | number | undefined>;
  switch (event.type) {
    case "mushaf_created":
      return {
        dot: "var(--text-muted)",
        text: i18n.t("details.act_uploaded", {
          name: p.pdf_original_name || i18n.t("details.act_pdfFallback"),
        }),
      };
    case "bounds_set":
      return {
        dot: "var(--navy-light)",
        text: i18n.t("details.act_boundsSet", { first: p.first, last: p.last }),
      };
    case "template_saved":
      return {
        dot: "var(--success)",
        text: i18n.t("details.act_templateSaved", {
          // Named from the shared per-type strings. This was a binary ternary and
          // would have called a sajda a sura header.
          type: i18n.t(`templates.name_${p.template_type as TemplateType}`),
        }),
      };
    case "run_finished": {
      const num = runNumberLabel(Number(p.run_number ?? 0));
      if (p.status === "completed") {
        return {
          dot: "var(--success)",
          text: i18n.t("details.act_runCompleted", {
            num,
            start: p.page_range_start,
            end: p.page_range_end,
          }),
        };
      }
      if (p.status === "aborted_line_detection") {
        return {
          dot: "var(--warning)",
          text: p.abort_page
            ? i18n.t("details.act_runAbortedAt", { num, page: p.abort_page })
            : i18n.t("details.act_runAborted", { num }),
        };
      }
      if (p.status === "cancelled") {
        return {
          dot: "var(--text-muted)",
          // `saved`, not `count` — i18next treats `count` as a plural selector.
          text: i18n.t("details.act_runCancelled", { num, saved: Number(p.pages_saved ?? 0) }),
        };
      }
      return { dot: "var(--error)", text: i18n.t("details.act_runFailed", { num }) };
    }
    case "review_saved":
      return {
        dot: "var(--orange)",
        text:
          p.page_start != null
            ? i18n.t("details.act_reviewRange", {
                start: p.page_start,
                end: p.page_end,
                shown: p.count,
              })
            : i18n.t("details.act_reviewPage", { page: p.page_number }),
      };
    case "lines_exported":
      return {
        dot: "var(--navy-light)",
        text: i18n.t("details.act_linesExported", { page: p.page_number, lines: p.exported }),
      };
    case "words_detected": {
      // A cancelled run still wrote everything it finished — it settles, it does
      // not fail — so it reads as a partial result rather than an error.
      const span = `${p.from ?? "?"} → ${p.to ?? "?"}`;
      if (p.cancelled) {
        return {
          dot: "var(--text-muted)",
          text: i18n.t("details.act_wordsStopped", { span, lines: Number(p.lines ?? 0) }),
        };
      }
      return {
        dot: Number(p.unresolved ?? 0) > 0 ? "var(--warning)" : "var(--success)",
        text: i18n.t("details.act_wordsDetected", {
          span,
          words: Number(p.words ?? 0),
          lines: Number(p.lines ?? 0),
        }),
      };
    }
    case "words_edited":
      return {
        dot: "var(--orange)",
        text: i18n.t("details.act_wordsEdited", {
          page: p.page_number,
          lines: Number(p.lines ?? 0),
        }),
      };
    default:
      return { dot: "var(--text-muted)", text: event.type };
  }
}

// ── Pipeline derivation ──────────────────────────────────────────────────────
/** The slug is the URL and the i18n key, and `finalize` keeps both even though
 * that step now reads "Lines" — it stopped being the final one when Words landed
 * after it, and renaming the route would break every saved link for a label. */
export type StepSlug =
  | "setup"
  | "templates"
  | "process"
  | "review"
  | "finalize"
  | "word-run"
  | "word-cuts";

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
  wordCoverage?: WordCoverage,
): StepInfo[] {
  const logical = mushaf.logical_page_count;
  const processed = mushaf.processed_page_count;
  const reviewed = mushaf.reviewed_page_count;
  const exported = stats?.exported_pngs ?? 0;
  const linesCut = stats?.lines_cut ?? 0;

  const process: StepInfo =
    processed === 0
      ? {
          slug: "process",
          label: i18n.t("header.steps.process"),
          state: "todo",
          detail: i18n.t("details.step_pages", { done: 0, total: logical }),
        }
      : processed >= logical
        ? {
            slug: "process",
            label: i18n.t("header.steps.process"),
            state: "done",
            detail: i18n.t("details.step_pages", { done: processed, total: logical }),
          }
        : {
            slug: "process",
            label: i18n.t("header.steps.process"),
            state: "active",
            detail: abortPage
              ? i18n.t("details.step_pagesAbort", { done: processed, total: logical })
              : i18n.t("details.step_pages", { done: processed, total: logical }),
            warn: !!abortPage,
          };

  const review: StepInfo =
    processed === 0
      ? {
          slug: "review",
          label: i18n.t("header.steps.review"),
          state: "todo",
          detail: i18n.t("details.step_awaiting"),
        }
      : reviewed >= processed
        ? {
            slug: "review",
            label: i18n.t("header.steps.review"),
            state: "done",
            detail: i18n.t("details.step_pages", { done: reviewed, total: processed }),
          }
        : {
            slug: "review",
            label: i18n.t("header.steps.review"),
            state: "active",
            detail: i18n.t("details.step_pages", { done: reviewed, total: processed }),
          };

  const finalize: StepInfo =
    exported === 0
      ? {
          slug: "finalize",
          label: i18n.t("header.steps.finalize"),
          state: "todo",
          detail: i18n.t("details.step_pngsOut", { count: 0 }),
        }
      : exported >= linesCut && linesCut > 0
        ? {
            slug: "finalize",
            label: i18n.t("header.steps.finalize"),
            state: "done",
            detail: i18n.t("details.step_pngsOut", { count: exported }),
          }
        : {
            slug: "finalize",
            label: i18n.t("header.steps.finalize"),
            state: "active",
            detail: i18n.t("details.step_pngsProgress", { done: exported, total: linesCut }),
          };

  // Words is the one step with no "how far through" to report until it has run at
  // all: coverage lists only pages that hold Line rows, so an empty list means the
  // engine has never been over this mushaf, not that it found nothing.
  //
  // Split in two the way the pages are: the run is done once anything has been
  // read, and the cuts are done once nothing is left flagged. Reading "Words done,
  // Cuts active" is the honest state of a mushaf the engine has covered and nobody
  // has checked — which one combined step could not say.
  const wordPages = wordCoverage?.pages.filter((p) => p.lines_with_words > 0) ?? [];
  const flaggedLines = wordPages.reduce((n, p) => n + p.needs_review, 0);
  const hasWords = wordPages.length > 0;
  const wordRun: StepInfo = {
    slug: "word-run",
    label: i18n.t("header.steps.word-run"),
    state: hasWords ? "done" : "todo",
    detail: hasWords
      ? i18n.t("details.step_wordsDone", { pages: wordPages.length })
      : i18n.t("details.step_wordsTodo"),
  };
  const wordCuts: StepInfo = !hasWords
    ? {
        slug: "word-cuts",
        label: i18n.t("header.steps.word-cuts"),
        state: "todo",
        detail: i18n.t("details.step_wordsTodo"),
      }
    : flaggedLines === 0 && wordCoverage?.complete
      ? {
          slug: "word-cuts",
          label: i18n.t("header.steps.word-cuts"),
          state: "done",
          detail: i18n.t("details.step_wordsDone", { pages: wordPages.length }),
        }
      : {
          slug: "word-cuts",
          label: i18n.t("header.steps.word-cuts"),
          state: "active",
          detail: i18n.t("details.step_wordsFlagged", { count: flaggedLines }),
        };

  return [
    {
      slug: "setup",
      label: i18n.t("header.steps.setup"),
      state: "done",
      detail: i18n.t("details.step_setupDetail", {
        first: mushaf.first_quran_pdf_page,
        last: mushaf.last_quran_pdf_page,
      }),
    },
    {
      slug: "templates",
      label: i18n.t("header.steps.templates"),
      state: templatesReady ? "done" : "active",
      detail: templatesReady
        ? i18n.t("details.step_templatesReady")
        : i18n.t("details.step_templatesTodo"),
    },
    process,
    review,
    finalize,
    wordRun,
    wordCuts,
  ];
}

/** Where "Continue →" should land, with its two-line CTA sublabel. */
export function continueTarget(
  mushaf: MushafDetail,
  templatesReady: boolean,
  summaries: PageSummary[] | undefined,
  stats: MushafStats | undefined,
  wordCoverage?: WordCoverage,
): { slug: StepSlug; sub: string; reviewPage?: number } {
  const processed = mushaf.processed_page_count;
  const reviewed = mushaf.reviewed_page_count;
  if (!templatesReady && processed === 0)
    return { slug: "setup", sub: i18n.t("details.cta_setup") };
  if (!templatesReady) return { slug: "templates", sub: i18n.t("details.cta_templates") };
  if (processed === 0)
    return {
      slug: "process",
      sub: i18n.t("details.cta_process", { total: mushaf.logical_page_count }),
    };
  if (reviewed < processed) {
    const firstUnreviewed = summaries?.find((s) => !s.reviewed)?.page_number ?? reviewed + 1;
    return {
      slug: "review",
      sub: i18n.t("details.cta_review", { page: firstUnreviewed, total: processed }),
      reviewPage: firstUnreviewed,
    };
  }
  const exported = stats?.exported_pngs ?? 0;
  if (exported === 0)
    return { slug: "finalize", sub: i18n.t("details.cta_finalize", { count: 0 }) };

  // Words comes last, and only once the lines are out: the engine reads a line
  // image with Finalize's erase strokes already punched out of it (see
  // export.render_line_image), so running before that is reading the wrong ink.
  // A flagged page sends you to the cuts, with the page; nothing read yet sends
  // you to the run. The two used to be one destination because they were one page.
  const flagged = (wordCoverage?.pages ?? []).find((p) => p.needs_review > 0);
  if (flagged) {
    return {
      slug: "word-cuts",
      sub: i18n.t("details.cta_wordsReview", { page: flagged.page }),
      reviewPage: flagged.page,
    };
  }
  if (!wordCoverage?.pages.some((p) => p.lines_with_words > 0)) {
    return { slug: "word-run", sub: i18n.t("details.cta_wordsRun") };
  }
  return { slug: "finalize", sub: i18n.t("details.cta_finalize", { count: exported }) };
}

export const STEP_ROUTES = {
  setup: "/mushafs/$mushafId/setup",
  templates: "/mushafs/$mushafId/templates",
  process: "/mushafs/$mushafId/process",
  review: "/mushafs/$mushafId/review",
  finalize: "/mushafs/$mushafId/finalize",
  "word-run": "/mushafs/$mushafId/word-run",
  "word-cuts": "/mushafs/$mushafId/word-cuts",
} as const satisfies Record<StepSlug, string>;

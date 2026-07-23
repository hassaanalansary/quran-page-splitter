import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { TemplatePreview } from "@/components/canvas/TemplatePreview";
import { Aside, Field, Hint, Section, StatusLine } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { InfoTip } from "@/components/app/InfoTip";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { ProcessAbortDialog } from "@/components/app/ProcessAbortDialog";
import { ProcessConfirmDialog } from "@/components/app/ProcessConfirmDialog";
import { CropPreview } from "@/components/canvas/CropPreview";
import { PageStage } from "@/components/canvas/PageStage";
import { RectInputs } from "@/components/canvas/RectInputs";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  DEFAULT_PROCESS_SETTINGS,
  pageImageUrl,
  processMushaf,
  queryKeys,
  useMushaf,
  useProcessedPages,
  useRuns,
  useSuras,
  type ProcessRequest,
  type ProcessResult,
  type ProcessSettings,
  type Rect,
} from "@/lib/api";
import {
  readLastProcessRequestFor,
  writeLastProcessOutcome,
  writeLastProcessRequest,
} from "@/lib/lastProcessRequest";
import { readFlag, writeFlag } from "@/lib/prefs";

export const Route = createFileRoute("/mushafs/$mushafId/process")({
  component: ProcessPage,
  // Optional `?run=<id>` pre-fills the form from a stored run's settings;
  // optional `?from=<page>` overrides the start page (used by "Resume").
  validateSearch: (s: Record<string, unknown>): { run?: string; from?: number } => {
    const run = typeof s.run === "string" && s.run ? s.run : undefined;
    const fromNum = Math.floor(Number(s.from));
    const from = Number.isFinite(fromNum) && fromNum >= 1 ? fromNum : undefined;
    return { run, from };
  },
});

const CHUNK_SIZE = 50;
/** Above this many pages, a mushaf's very first run gets a "test small" advisory. */
const FIRST_RUN_SAFE_PAGES = 10;
/** Al-Fatiha and the opening page of Al-Baqara are laid out unlike the rest of
 * the mushaf, so line detection can't read them — the range starts past them. */
const FIRST_DETECTABLE_PAGE = 3;
const DEFAULT_RANGE_END = 10;
const PREVIEW_PREF_KEY = "qps.process.previewOpen";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Rebuild settings from a stored payload (a run's `settings`, or the localStorage
 * snapshot), falling back to the defaults for anything missing or malformed. */
function settingsFrom(s: Record<string, unknown>): ProcessSettings {
  const numOr = (v: unknown, fallback: number) =>
    v == null || Number.isNaN(Number(v)) ? fallback : Number(v);
  return {
    padding: numOr(s.padding, DEFAULT_PROCESS_SETTINGS.padding),
    expected_lines: numOr(s.expected_lines, DEFAULT_PROCESS_SETTINGS.expected_lines),
    sura_header_slots: numOr(s.sura_header_slots, DEFAULT_PROCESS_SETTINGS.sura_header_slots),
    sura_header_threshold: numOr(
      s.sura_header_threshold,
      DEFAULT_PROCESS_SETTINGS.sura_header_threshold,
    ),
    max_sura_headers: numOr(s.max_sura_headers, DEFAULT_PROCESS_SETTINGS.max_sura_headers),
    match_threshold: numOr(s.match_threshold, DEFAULT_PROCESS_SETTINGS.match_threshold),
    alternate_horizontal_margin: Boolean(s.alternate_horizontal_margin),
    prefer_acceleration:
      s.prefer_acceleration == null
        ? DEFAULT_PROCESS_SETTINGS.prefer_acceleration
        : Boolean(s.prefer_acceleration),
  };
}

type RunState = {
  running: boolean;
  /** Logical pages actually written — an aborted chunk saves only what precedes it. */
  done: number;
  total: number;
  finished: boolean;
  abort: ProcessResult | null;
  /** Logical page detection stopped on. */
  abortPage: number | null;
  error: string | null;
};

function ProcessPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/process" });
  const { run: runId, from: resumeFrom } = Route.useSearch();
  const { data: mushaf } = useMushaf(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: runs } = useRuns(mushafId);
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const logicalCount = mushaf?.logical_page_count ?? 1;

  const [preview, setPreview] = useState(1);
  const [bounds, setBounds] = useState<Rect | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [rangeStart, setRangeStart] = useState(FIRST_DETECTABLE_PAGE);
  const [rangeEnd, setRangeEnd] = useState(DEFAULT_RANGE_END);
  const [startSura, setStartSura] = useState(1);
  const [startAya, setStartAya] = useState(1);
  const [settings, setSettings] = useState<ProcessSettings>(DEFAULT_PROCESS_SETTINGS);
  const [run, setRun] = useState<RunState | null>(null);
  const [loadedRun, setLoadedRun] = useState<{ label: string; from?: number } | null>(null);
  const [boundsLocked, setBoundsLocked] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(() => readFlag(PREVIEW_PREF_KEY));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const appliedRunRef = useRef<string | null>(null);
  const initedRef = useRef(false);
  const outcomeRef = useRef<HTMLDivElement>(null);

  // Pre-fill the form from a stored run when arriving via `?run=<id>` (Runs tab
  // → "Re-run with these settings"). Applied once per run id so later manual
  // edits are never clobbered by a query refetch.
  useEffect(() => {
    if (!runId || !runs || !mushaf) return;
    if (appliedRunRef.current === runId) return;
    const target = runs.find((r) => r.id === runId);
    if (!target) return;
    appliedRunRef.current = runId;

    const s = target.settings;
    setSettings(settingsFrom(s));
    if (s.start_sura != null) setStartSura(Number(s.start_sura));
    if (s.start_aya != null) setStartAya(Number(s.start_aya));
    setRangeStart(clamp(resumeFrom ?? target.page_range_start, 1, logicalCount));
    setRangeEnd(clamp(target.page_range_end, 1, logicalCount));
    const b = s.bounds as Rect | undefined;
    if (b && typeof b.x === "number") {
      setBounds({ x: b.x, y: b.y, w: b.w, h: b.h });
      setBoundsLocked(true);
    }

    const label = `#${String(target.run_number).padStart(2, "0")}`;
    setLoadedRun({ label, from: resumeFrom });
    toast.success(
      resumeFrom
        ? t("process.loadedToastResume", { label, from: resumeFrom })
        : t("process.loadedToast", { label }),
    );
  }, [runId, runs, mushaf, resumeFrom, logicalCount, t]);

  // First load of a plain visit: clamp the default 3–10 range to the mushaf, then
  // let the last request sent for THIS mushaf refill the form if one was stored.
  // `?run=` wins — it is an explicit request for a specific run's settings.
  useEffect(() => {
    if (!mushaf || initedRef.current) return;
    initedRef.current = true;
    if (runId) return;
    setRangeStart(clamp(FIRST_DETECTABLE_PAGE, 1, logicalCount));
    setRangeEnd(clamp(DEFAULT_RANGE_END, 1, logicalCount));

    const last = readLastProcessRequestFor(mushafId);
    if (!last) return;
    const r = last.request;
    setSettings(settingsFrom(r as unknown as Record<string, unknown>));
    setBounds({ x: r.bounds.x, y: r.bounds.y, w: r.bounds.w, h: r.bounds.h });
    setBoundsLocked(true);
    setRangeStart(clamp(Number(r.page_range_start) || 1, 1, logicalCount));
    setRangeEnd(clamp(Number(r.page_range_end) || logicalCount, 1, logicalCount));
    if (r.start_sura != null) setStartSura(Number(r.start_sura));
    if (r.start_aya != null) setStartAya(Number(r.start_aya));
    toast.info(
      t("process.restored", { when: new Date(last.sent_at).toLocaleString(i18n.language) }),
    );
  }, [mushaf, mushafId, runId, logicalCount, i18n.language, t]);

  // A run that stops is easy to miss: the panel card sits above a long settings
  // list, so scroll it back into view when one appears.
  useEffect(() => {
    if (run?.abort || run?.error) {
      outcomeRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [run?.abort, run?.error]);

  const tourSteps: TourStep[] = [
    {
      target: "process-bounds",
      title: t("tour.process.t1_title"),
      body: t("tour.process.t1_body"),
    },
    { target: "process-range", title: t("tour.process.t2_title"), body: t("tour.process.t2_body") },
    { target: "process-start", title: t("tour.process.t3_title"), body: t("tour.process.t3_body") },
    {
      target: "process-settings",
      title: t("tour.process.settings_title"),
      body: t("tour.process.settings_body"),
    },
    { target: "process-run", title: t("tour.process.t4_title"), body: t("tour.process.t4_body") },
  ];
  const tour = useStepTour("process", tourSteps, (mushaf?.processed_page_count ?? 1) === 0);

  if (!mushaf) return null;

  const startSuraRow = suras?.find((s) => s.number === startSura);
  const ayaMax = startSuraRow?.aya_count ?? 286;
  const boundsOk = !!bounds && bounds.w >= 10 && bounds.h >= 10;
  const rangeOk = rangeStart >= 1 && rangeStart <= rangeEnd && rangeEnd <= logicalCount;
  const canProcess = boundsOk && rangeOk && !run?.running;
  const pageCount = rangeEnd - rangeStart + 1;

  // "First time on this mushaf" — nothing processed and no run on record. A long
  // range then means a long wait before the user finds out the settings were off.
  const everProcessed = mushaf.processed_page_count > 0 || (runs?.length ?? 0) > 0;
  const firstRun = !everProcessed && !run;
  // Pages 1–2 are undetectable, so that warning outranks the long-range one.
  const earlyPages = rangeStart < FIRST_DETECTABLE_PAGE && logicalCount >= FIRST_DETECTABLE_PAGE;
  const firstRunRisky = firstRun && rangeOk && pageCount > FIRST_RUN_SAFE_PAGES;
  const suggestedEnd = clamp(rangeStart + FIRST_RUN_SAFE_PAGES - 1, 1, logicalCount);

  function togglePreview() {
    setPreviewOpen((open) => {
      writeFlag(PREVIEW_PREF_KEY, !open);
      return !open;
    });
  }

  function toggleBoundsLock() {
    setBoundsLocked((locked) => {
      toast.success(locked ? t("process.unlockedToast") : t("process.lockedToast"));
      return !locked;
    });
  }

  // Preview the alternate-margin flip exactly as the engine applies it: the
  // engine anchors the mirror to the first page of the batch (page_index starts
  // at 1) and swaps every other page from there — so a page flips when its
  // offset from the start page is odd. Chunking by 50 (even) preserves parity,
  // so anchoring the preview to `rangeStart` matches every chunk. See
  // core/line_detector.py (`should_swap`) and core/pipeline.py (`enumerate`, start=1).
  const flipPreview = settings.alternate_horizontal_margin && (preview - rangeStart) % 2 !== 0;

  // Plain instructions, not a checklist: this step is one long form, and ticking
  // items off said "done" for things the user can still get wrong.
  const guideItems = [
    { label: t("guide.process.s1") },
    { label: t("guide.process.s2") },
    { label: t("guide.process.s3") },
    { label: t("guide.process.s4") },
    { label: t("guide.process.s5") },
  ];
  const status = run?.running ? (
    <StatusLine>{t("process.processing")}</StatusLine>
  ) : run?.abort ? (
    <StatusLine tone="error">
      {t("process.abortStatus", { page: run.abortPage ?? "?", count: run.done })}
    </StatusLine>
  ) : run?.error ? (
    <StatusLine tone="error">{t("process.errorStatus")}</StatusLine>
  ) : run?.finished ? (
    <StatusLine tone="success">{t("stepStatus.processDone")}</StatusLine>
  ) : !boundsOk ? (
    <StatusLine tone="warning">{t("stepStatus.processNoBounds")}</StatusLine>
  ) : !rangeOk ? (
    <StatusLine tone="warning">{t("process.rangeError", { max: logicalCount })}</StatusLine>
  ) : earlyPages ? (
    <StatusLine tone="warning">{t("process.earlyPagesStatus")}</StatusLine>
  ) : firstRunRisky ? (
    <StatusLine tone="warning">{t("process.firstRunStatus")}</StatusLine>
  ) : (
    <StatusLine tone="success">
      {t("stepStatus.processReady", { start: rangeStart, end: rangeEnd })}
    </StatusLine>
  );

  async function runProcess() {
    if (!bounds) return;
    const total = rangeEnd - rangeStart + 1;
    setRun({
      running: true,
      done: 0,
      total,
      finished: false,
      abort: null,
      abortPage: null,
      error: null,
    });

    // Mirror the whole request before it leaves — one snapshot, overwritten each
    // run, so coming back to this mushaf refills the form exactly as sent.
    const request: ProcessRequest = {
      ...settings,
      page_range_start: rangeStart,
      page_range_end: rangeEnd,
      start_sura: startSura,
      start_aya: startAya,
      bounds,
    };
    writeLastProcessRequest({
      mushaf_id: mushafId,
      mushaf_name: mushaf?.name,
      sent_at: new Date().toISOString(),
      request,
    });

    let curSura = startSura;
    let curAya = startAya;
    let saved = 0;
    try {
      for (let from = rangeStart; from <= rangeEnd; from += CHUNK_SIZE) {
        const to = Math.min(from + CHUNK_SIZE - 1, rangeEnd);
        const out = await processMushaf(mushafId, {
          ...settings,
          page_range_start: from,
          page_range_end: to,
          start_sura: curSura,
          start_aya: curAya,
          bounds,
        });
        if (out.status !== "completed") {
          // `page_index` is 1-based within the chunk, and the failing page itself
          // writes nothing — everything before it in the chunk was saved.
          const index = out.abort_info?.page_index ?? 1;
          const page = from + index - 1;
          saved += index - 1;
          setRun((r) =>
            r
              ? { ...r, running: false, done: saved, finished: true, abort: out, abortPage: page }
              : r,
          );
          writeLastProcessOutcome(mushafId, {
            status: "aborted",
            pages_saved: saved,
            abort_page: page,
            ended_at: new Date().toISOString(),
          });
          setDetailsOpen(true);
          return;
        }
        saved = to - rangeStart + 1;
        setRun((r) => (r ? { ...r, done: saved } : r));
        curSura = out.end_sura;
        curAya = out.end_aya;
      }
      setRun((r) => (r ? { ...r, running: false, finished: true } : r));
      writeLastProcessOutcome(mushafId, {
        status: "completed",
        pages_saved: saved,
        ended_at: new Date().toISOString(),
      });
      toast.success(t("process.processedToast", { start: rangeStart, end: rangeEnd }));
    } catch (e) {
      const message = e instanceof ApiError ? e.message : t("process.processFailed");
      setRun((r) => (r ? { ...r, running: false, done: saved, error: message } : r));
      writeLastProcessOutcome(mushafId, {
        status: "error",
        pages_saved: saved,
        message,
        ended_at: new Date().toISOString(),
      });
      setDetailsOpen(true);
      toast.error(message);
    } finally {
      queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runs(mushafId) });
    }
  }

  /** Pick up where an aborted run stopped: same settings, new start page. */
  function resumeFromAbort() {
    if (run?.abortPage == null) return;
    const page = clamp(run.abortPage, 1, logicalCount);
    setRangeStart(page);
    setDetailsOpen(false);
    toast.success(t("process.abortResumeToast", { page }));
  }

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <div data-tour="process-bounds" className="relative flex flex-1 overflow-hidden">
        <PageStage
          imageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
          page={preview}
          pageCount={logicalCount}
          onPageChange={(n) => setPreview(clamp(n, 1, logicalCount))}
          renderLabel={(p) =>
            t("process.pdfPageLabel", {
              pdf: mushaf.first_quran_pdf_page + p - 1,
              total: mushaf.pdf_page_count,
            })
          }
          crop={{
            label: t("process.boundsLabel"),
            rect: bounds,
            onRectChange: setBounds,
            mirrored: flipPreview,
            locked: boundsLocked,
            onLockToggle: toggleBoundsLock,
          }}
          onNatural={setNatural}
          processed={pages?.processed}
          reviewed={pages?.reviewed}
        />
        <CanvasHelp
          guideItems={guideItems}
          guideAbout={t("guide.aboutStatic")}
          coachText={t("coach.process")}
          onReplayTour={tour.start}
        />
      </div>

      {previewOpen ? (
        <div className="flex w-[400px] flex-shrink-0 flex-col gap-3 overflow-auto border-s border-border bg-white p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[12px] font-semibold capitalize text-text-primary">
              {t("process.boundsTitle")}
            </h3>
            <button
              type="button"
              onClick={togglePreview}
              title={t("process.previewHide")}
              aria-label={t("process.previewHide")}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-surface hover:text-orange focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <EyeOff size={14} />
            </button>
          </div>
          <TemplatePreview
            mode="bounds"
            pageUrl={pageImageUrl(mushafId, preview, mushaf.updated_at)}
            working={bounds}
            mirrored={flipPreview}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={togglePreview}
          title={t("process.previewShow")}
          aria-label={t("process.previewShow")}
          className="flex w-9 flex-shrink-0 cursor-pointer flex-col items-center gap-2 border-s border-border bg-white py-3 text-text-muted transition-colors hover:bg-bg-surface hover:text-orange focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <Eye size={15} />
          <span className="text-[11px] tracking-wide [writing-mode:vertical-rl]">
            {t("canvas.tpl_boundsPreview")}
          </span>
        </button>
      )}

      <Aside
        status={status}
        footer={
          <div data-tour="process-run" className="flex flex-col gap-2">
            {run && <ProgressFooter run={run} />}
            <Button onClick={() => setConfirmOpen(true)} disabled={!canProcess}>
              {run?.running
                ? t("process.processing")
                : t("process.processButton", { start: rangeStart, end: rangeEnd })}
            </Button>
            {(run?.abort || run?.error) && (
              <Button variant="outline" onClick={() => setDetailsOpen(true)}>
                {t("process.abortDetails")}
              </Button>
            )}
            {run?.finished && !run.error && !run.abort && (
              <Button asChild variant="outline">
                <Link
                  to="/mushafs/$mushafId/review"
                  params={{ mushafId }}
                  search={{ page: rangeStart }}
                >
                  {t("process.continueReview")}
                </Link>
              </Button>
            )}
          </div>
        }
      >
        {(run?.abort || run?.error) && (
          <div ref={outcomeRef} className="scroll-mt-2">
            <OutcomeCard
              abortPage={run.abortPage}
              pagesSaved={run.done}
              error={run.error}
              onDetails={() => setDetailsOpen(true)}
            />
          </div>
        )}

        {loadedRun && (
          <Hint>
            {loadedRun.from
              ? t("process.loadedRunResume", { label: loadedRun.label, from: loadedRun.from })
              : t("process.loadedRun", { label: loadedRun.label })}
          </Hint>
        )}

        <Section title={t("process.boundsTitle")}>
          <div className="flex items-center justify-between text-[12px]">
            <span className="flex items-center gap-1 text-text-secondary">
              {t("process.region")}
              <InfoTip text={t("process.boundsHelp")} />
            </span>
            <span className="font-mono text-text-primary">
              {bounds
                ? `${Math.round(bounds.w)}×${Math.round(bounds.h)} @ ${Math.round(bounds.x)},${Math.round(bounds.y)}`
                : "—"}
            </span>
          </div>
          <RectInputs rect={bounds} onChange={setBounds} max={natural} disabled={boundsLocked} />
          {!boundsOk && <span className="text-[12px] text-error">{t("process.boundsError")}</span>}
          {flipPreview && (
            <span className="text-[12px]" style={{ color: "var(--navy)" }}>
              {t("process.flipHint", { page: preview, start: rangeStart })}
            </span>
          )}
        </Section>

        <div data-tour="process-range">
          <Section title={t("process.pageRange")}>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("process.startPage")} info={t("tips.pageRange")}>
                <NumInput value={rangeStart} min={1} max={logicalCount} onChange={setRangeStart} />
              </Field>
              <Field label={t("process.endPage")}>
                <NumInput value={rangeEnd} min={1} max={logicalCount} onChange={setRangeEnd} />
              </Field>
            </div>
            {!rangeOk && (
              <span className="text-[12px] text-error">
                {t("process.rangeError", { max: logicalCount })}
              </span>
            )}
            {rangeOk && earlyPages && (
              <RangeNotice
                text={t("process.earlyPagesShort")}
                action={t("process.earlyPagesApply", { page: FIRST_DETECTABLE_PAGE })}
                detail={t("process.earlyPagesBody")}
                onApply={() => {
                  const start = clamp(FIRST_DETECTABLE_PAGE, 1, logicalCount);
                  setRangeStart(start);
                  setRangeEnd((end) => Math.max(end, start));
                }}
              />
            )}
            {rangeOk && !earlyPages && firstRunRisky && (
              <RangeNotice
                text={t("process.firstRunShort", { count: pageCount })}
                action={t("process.firstRunApplyShort", { start: rangeStart, end: suggestedEnd })}
                detail={t("process.firstRunBody", { count: pageCount })}
                onApply={() => setRangeEnd(suggestedEnd)}
              />
            )}
          </Section>
        </div>

        <div data-tour="process-start">
          <Section title={t("process.startingPosition")}>
            <Field label={t("process.startSura")} info={t("tips.startSura")}>
              <select
                value={startSura}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setStartSura(n);
                  const max = suras?.find((s) => s.number === n)?.aya_count ?? 286;
                  setStartAya((a) => clamp(a, 1, max));
                }}
                className={selectClass}
              >
                {(suras ?? []).map((s) => (
                  <option key={s.number} value={s.number}>
                    {s.number}. {s.name_arabic} — {s.transliteration}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("process.startAya")} info={t("tips.startAya")}>
              <select
                value={startAya}
                onChange={(e) => setStartAya(Number(e.target.value))}
                className={selectClass}
              >
                {Array.from({ length: ayaMax }, (_, i) => i + 1).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
          </Section>
        </div>

        <div data-tour="process-settings">
          <SettingsCard settings={settings} onChange={setSettings} />
        </div>
      </Aside>

      {bounds && (
        <ProcessConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={() => {
            setConfirmOpen(false);
            void runProcess();
          }}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          startSuraLabel={
            startSuraRow
              ? `${startSuraRow.number}. ${startSuraRow.name_arabic} — ${startSuraRow.transliteration}`
              : String(startSura)
          }
          startAya={startAya}
          bounds={bounds}
          settings={settings}
          chunkSize={CHUNK_SIZE}
          firstRun={firstRunRisky}
          earlyPages={earlyPages}
        />
      )}

      {(run?.abort || run?.error) && (
        <ProcessAbortDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          kind={run.abort ? "abort" : "error"}
          info={run.abort?.abort_info}
          page={run.abortPage}
          pagesSaved={run.done}
          logUrl={run.abort?.log_url}
          errorMessage={run.error}
          onResume={run.abortPage != null ? resumeFromAbort : undefined}
        />
      )}

      <TourOverlay tour={tour} />
    </div>
  );
}

const selectClass =
  "h-9 w-full cursor-pointer rounded-md border-[1.5px] border-border-strong bg-white px-2.5 text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]";

function ProgressFooter({ run }: { run: RunState }) {
  const { t } = useTranslation();
  const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
        <div
          className={`h-full rounded-full ${run.abort || run.error ? "bg-error" : "bg-orange"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11.5px] text-text-muted">
        {run.running
          ? t("process.progressActive", { done: run.done, total: run.total })
          : t("process.progress", { done: run.done, total: run.total })}
      </span>
    </div>
  );
}

/** Panel-side summary of a stopped run. The evidence itself lives in the dialog —
 * this card only has to be impossible to miss and one click away from it. */
function OutcomeCard({
  abortPage,
  pagesSaved,
  error,
  onDetails,
}: {
  abortPage: number | null;
  pagesSaved: number;
  error: string | null;
  onDetails: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-error-border bg-error-bg px-3 py-2.5 text-[12px] text-error">
      <div className="flex items-center gap-1.5 font-semibold">
        <TriangleAlert size={14} className="flex-shrink-0" />
        {error ? t("process.errorDialogTitle") : t("process.abortTitle")}
      </div>
      <div className="mb-2.5 mt-1 leading-[1.55]">
        {error ?? t("process.abortLead", { page: abortPage ?? "?" })}
      </div>
      <div className="mb-2.5 font-mono text-[11px]">
        {t("process.abortSavedCount", { count: pagesSaved })}
      </div>
      <Button size="sm" variant="outline" onClick={onDetails}>
        {t("process.abortDetails")}
      </Button>
    </div>
  );
}

/** One-line range advisory: short text, inline fix, full reasoning on the (i).
 * The panel is crowded, so the long version lives in the confirm dialog. */
function RangeNotice({
  text,
  action,
  detail,
  onApply,
}: {
  text: string;
  action: string;
  detail: string;
  onApply: () => void;
}) {
  return (
    <div className="flex items-start gap-1.5 text-[11.5px] leading-[1.45] text-[#8a4b0d]">
      <TriangleAlert size={12} className="mt-[2px] flex-none" />
      <span>
        {text}{" "}
        <button
          type="button"
          onClick={onApply}
          className="cursor-pointer font-semibold underline underline-offset-2 hover:text-orange"
        >
          {action}
        </button>{" "}
        <InfoTip text={detail} />
      </span>
    </div>
  );
}

function SettingsCard({
  settings,
  onChange,
}: {
  settings: ProcessSettings;
  onChange: (s: ProcessSettings) => void;
}) {
  const { t } = useTranslation();
  const u = (patch: Partial<ProcessSettings>) => onChange({ ...settings, ...patch });
  return (
    <Section title={t("process.detectionSettings")} defaultOpen={true}>
      <Row label={t("process.padding")} hint={t("process.paddingHint")} info={t("tips.padding")}>
        <NumInput value={settings.padding} min={0} onChange={(v) => u({ padding: v })} compact />
      </Row>
      <Row
        label={t("process.linesPerPage")}
        hint={t("process.linesPerPageHint")}
        info={t("tips.expectedLines")}
      >
        <NumInput
          value={settings.expected_lines}
          min={1}
          onChange={(v) => u({ expected_lines: v })}
          compact
        />
      </Row>
      <Row label={t("process.headerSlots")} info={t("tips.headerSlots")}>
        <NumInput
          value={settings.sura_header_slots}
          min={1}
          onChange={(v) => u({ sura_header_slots: v })}
          compact
        />
      </Row>
      <Row
        label={t("process.headerThreshold")}
        hint={t("process.headerThresholdHint")}
        info={t("tips.headerThreshold")}
      >
        <NumInput
          value={settings.sura_header_threshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => u({ sura_header_threshold: v })}
          compact
        />
      </Row>
      <Row label={t("process.maxHeaders")} info={t("tips.maxHeaders")}>
        <NumInput
          value={settings.max_sura_headers}
          min={1}
          onChange={(v) => u({ max_sura_headers: v })}
          compact
        />
      </Row>
      <Row
        label={t("process.ayaThreshold")}
        hint={t("process.ayaThresholdHint")}
        info={t("tips.ayaThreshold")}
      >
        <NumInput
          value={settings.match_threshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => u({ match_threshold: v })}
          compact
        />
      </Row>
      <Row
        label={t("process.altMargins")}
        hint={t("process.altMarginsHint")}
        info={t("tips.altMargins")}
      >
        <Toggle
          value={settings.alternate_horizontal_margin}
          onChange={(v) => u({ alternate_horizontal_margin: v })}
        />
      </Row>
      <Row
        label={t("process.preferAccel")}
        hint={t("process.preferAccelHint")}
        info={t("tips.preferAccel")}
        last
      >
        <Toggle
          value={settings.prefer_acceleration}
          onChange={(v) => u({ prefer_acceleration: v })}
        />
      </Row>
    </Section>
  );
}

function Row({
  label,
  hint,
  info,
  children,
  last,
}: {
  label: string;
  hint?: string;
  info?: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 py-1 ${last ? "" : "border-b border-border"}`}
    >
      <div className="flex flex-col">
        <span className="flex items-center gap-1 text-[13px] text-text-primary">
          {label}
          {info && <InfoTip text={info} />}
        </span>
        {hint && <span className="text-[10.5px] text-text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  min,
  max,
  step,
  compact,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  compact?: boolean;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => onChange(Number(e.target.value))}
      className={[
        compact ? "h-[30px] w-[68px]" : "h-9 w-full",
        "rounded-md border-[1.5px] border-border-strong bg-white px-2 text-right text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]",
      ].join(" ")}
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="relative h-5 w-9 flex-shrink-0 cursor-pointer rounded-[10px] transition-colors"
      style={{ background: value ? "var(--orange)" : "var(--border-strong)" }}
    >
      <span
        className="absolute top-[3px] h-[14px] w-[14px] rounded-full bg-white transition-all"
        style={{ left: value ? "19px" : "3px", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }}
      />
    </button>
  );
}

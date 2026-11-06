import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  Info,
  Lock,
  LockOpen,
  OctagonX,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CropPreview } from "@/components/canvas/CropPreview";
import { Aside, StatusLine, StepBody } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { InfoTip } from "@/components/app/InfoTip";
import { BusyLabel } from "@/components/app/SatrLoader";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { ProcessAbortDialog } from "@/components/app/ProcessAbortDialog";
import { ProcessCancelDialog } from "@/components/app/ProcessCancelDialog";
import { ProcessConfirmDialog } from "@/components/app/ProcessConfirmDialog";
import { RunLogDialog, RunLogDock } from "@/components/app/RunLogDialog";
import { PageStage } from "@/components/canvas/PageStage";
import { RectInputs } from "@/components/canvas/RectInputs";
import {
  ApiError,
  DEFAULT_PROCESS_SETTINGS,
  cancelProcess,
  isJobSettled,
  pageImageUrl,
  queryKeys,
  startProcess,
  useMushaf,
  useProcessedPages,
  useProcessJob,
  useRuns,
  useSuras,
  type ProcessJob,
  type ProcessRequest,
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

function ProcessPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/process" });
  const { run: runId, from: resumeFrom } = Route.useSearch();
  const { data: mushaf } = useMushaf(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: runs } = useRuns(mushafId);
  // The run lives on the server, so this is the single source of truth for it —
  // a reload, a second tab, or coming back later all pick it up from here.
  const { data: job } = useProcessJob(mushafId);
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
  const [loadedRun, setLoadedRun] = useState<{ label: string; from?: number } | null>(null);
  const [boundsLocked, setBoundsLocked] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(() => readFlag(PREVIEW_PREF_KEY));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /** Set once the user starts a run here, so an outcome from an earlier visit
   * (the server keeps the last job) doesn't pop its dialog open on arrival. */
  const [ownRun, setOwnRun] = useState(false);
  /** The settled job whose outcome has been taken in. State, not a ref: the
   * outcome card renders off it, and a ref would leave it a frame behind. */
  const [announcedJobId, setAnnouncedJobId] = useState<string | null>(null);
  const appliedRunRef = useRef<string | null>(null);
  const initedRef = useRef(false);
  const outcomeRef = useRef<HTMLDivElement>(null);
  /** Last job id seen actually working — see the settle effect. */
  const watchingRef = useRef<string | null>(null);

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

  // Split the polled job into the two shapes the page actually renders. Doing it
  // with plain ternaries (rather than a type guard) keeps both properly typed.
  const activeJob = job && !isJobSettled(job) ? job : null;
  const running = activeJob !== null;

  // React to a run *settling*, exactly once. The job outlives the page — the
  // server keeps the last one — so an outcome is only announced when this page
  // actually watched the run (started it, or saw it working). Landing here long
  // after a run stopped shows the outcome card, but throws no dialog or toast.
  useEffect(() => {
    if (!job) return;
    if (!isJobSettled(job)) {
      watchingRef.current = job.id;
      return;
    }
    if (announcedJobId === job.id) return;
    const watched = watchingRef.current === job.id || ownRun;
    setAnnouncedJobId(job.id);
    setCancelling(false);
    if (!watched) return;

    queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushafId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
    queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.runs(mushafId) });

    const ended_at = new Date().toISOString();
    const pages_saved = job.pages_saved;
    if (job.state === "completed") {
      writeLastProcessOutcome(mushafId, { status: "completed", pages_saved, ended_at });
      toast.success(
        t("process.processedToast", { start: job.page_range_start, end: job.page_range_end }),
      );
    } else if (job.state === "cancelled") {
      writeLastProcessOutcome(mushafId, {
        status: "cancelled",
        pages_saved,
        abort_page: job.stopped_on_page ?? undefined,
        ended_at,
      });
      toast.info(t("process.cancelledToast", { count: pages_saved }));
    } else if (job.state === "aborted_line_detection") {
      writeLastProcessOutcome(mushafId, {
        status: "aborted",
        pages_saved,
        abort_page: job.stopped_on_page ?? undefined,
        ended_at,
      });
      setDetailsOpen(true);
    } else if (job.state === "interrupted") {
      // The server lost the worker (restart, deploy, crash). Distinct from an
      // error: nothing went wrong with the *work*, and whatever pages were
      // saved before it stopped are still there to resume from.
      writeLastProcessOutcome(mushafId, {
        status: "error",
        pages_saved,
        abort_page: job.stopped_on_page ?? undefined,
        message: t("process.interruptedToast"),
        ended_at,
      });
      setDetailsOpen(true);
      toast.warning(t("process.interruptedToast", { count: pages_saved }));
    } else {
      writeLastProcessOutcome(mushafId, {
        status: "error",
        pages_saved,
        message: job.error ?? undefined,
        ended_at,
      });
      setDetailsOpen(true);
      toast.error(job.error ?? t("process.processFailed"));
    }
  }, [job, announcedJobId, ownRun, mushafId, queryClient, t]);

  // A run that stops is easy to miss: the panel card sits above a long settings
  // list, so scroll it back into view when one appears.
  useEffect(() => {
    if (announcedJobId) {
      outcomeRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [announcedJobId]);

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

  const imageUrl = pageImageUrl(mushafId, preview, mushaf.updated_at);
  const startSuraRow = suras?.find((s) => s.number === startSura);
  const ayaMax = startSuraRow?.aya_count ?? 286;
  const boundsOk = !!bounds && bounds.w >= 10 && bounds.h >= 10;
  const rangeOk = rangeStart >= 1 && rangeStart <= rangeEnd && rangeEnd <= logicalCount;
  const canProcess = boundsOk && rangeOk && !running && !starting;
  const pageCount = rangeEnd - rangeStart + 1;
  // The job's run, for "Run 6" and "View run 6's log"; a run just started may
  // not be in the list until it refetches.
  const runNumber = runs?.find((r) => r.id === job?.run_id)?.run_number;

  // A settled job is only surfaced once its outcome has been taken in (the
  // settle effect announces it), so nothing flashes on first paint.
  const settledJob = job && isJobSettled(job) && announcedJobId === job.id ? job : null;
  const aborted = settledJob?.state === "aborted_line_detection";
  const cancelled = settledJob?.state === "cancelled";
  const failed = settledJob?.state === "error";
  const completed = settledJob?.state === "completed";
  const stopped = aborted || cancelled || failed;

  // "First time on this mushaf" — nothing processed and no run on record. A long
  // range then means a long wait before the user finds out the settings were off.
  const everProcessed = mushaf.processed_page_count > 0 || (runs?.length ?? 0) > 0;
  const firstRun = !everProcessed && !job;
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
  // offset from the start page is odd. The whole range is now a single batch, so
  // `rangeStart` IS that anchor. (It used to be sliced into 50-page requests,
  // which only agreed with this because 50 is even.) See core/line_detector.py
  // (`should_swap`) and core/pipeline.py (`enumerate`, start=1).
  const flipPreview = settings.alternate_horizontal_margin && (preview - rangeStart) % 2 !== 0;

  // Plain instructions, not a checklist: this step is one long form, and ticking
  // items off said "done" for things the user can still get wrong.
  const guideItems = [
    t("guide.process.s1"),
    t("guide.process.s2"),
    t("guide.process.s3"),
    t("guide.process.s4"),
    t("guide.process.s5"),
  ];
  // While a run is going the run card says what it is doing; the line is for
  // the form's state.
  const status = activeJob ? undefined : aborted ? (
    <StatusLine tone="error">
      {t("process.abortStatus", {
        page: settledJob?.stopped_on_page ?? "?",
        count: settledJob?.pages_saved ?? 0,
      })}
    </StatusLine>
  ) : cancelled ? (
    <StatusLine tone="warning">
      {t("process.cancelStatus", {
        page: settledJob?.stopped_on_page ?? "?",
        count: settledJob?.pages_saved ?? 0,
      })}
    </StatusLine>
  ) : failed ? (
    <StatusLine tone="error">{t("process.errorStatus")}</StatusLine>
  ) : completed ? (
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

  /** Hand the run to the server and let the poll take over from here. */
  async function startRun() {
    if (!bounds) return;
    setStarting(true);

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

    try {
      const started = await startProcess(mushafId, request);
      setOwnRun(true);
      setDetailsOpen(false);
      // Seed the cache with the job the POST returned so progress shows at once
      // instead of after the first poll; the runs list picks up its number.
      queryClient.setQueryData(queryKeys.processJob(mushafId), started);
      queryClient.invalidateQueries({ queryKey: queryKeys.runs(mushafId) });
    } catch (e) {
      // Only the *start* can fail here (bad range, missing templates, one already
      // running). Anything that goes wrong later surfaces through the job.
      toast.error(e instanceof ApiError ? e.message : t("process.processFailed"));
      // A 409 means a run this page hasn't seen yet is already going — fetch it
      // so the user gets the progress instead of just the rejection.
      queryClient.invalidateQueries({ queryKey: queryKeys.processJob(mushafId) });
    } finally {
      setStarting(false);
    }
  }

  /** Ask the server to stop. It settles at the next page boundary; everything
   * already written stays written. Confirmed first — see ProcessCancelDialog. */
  async function cancelRun() {
    setCancelConfirmOpen(false);
    setCancelling(true);
    try {
      const updated = await cancelProcess(mushafId);
      queryClient.setQueryData(queryKeys.processJob(mushafId), updated);
      toast.info(t("process.cancelRequestedToast"));
    } catch (e) {
      setCancelling(false);
      // A 404 means it finished on its own between the click and the request.
      if (!(e instanceof ApiError && e.status === 404)) {
        toast.error(e instanceof ApiError ? e.message : t("process.cancelFailed"));
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.processJob(mushafId) });
    }
  }

  /** Pick up where a stopped run left off: same settings, new start page. */
  function resumeFromStop() {
    if (job?.stopped_on_page == null) return;
    const page = clamp(job.stopped_on_page, 1, logicalCount);
    setRangeStart(page);
    setDetailsOpen(false);
    toast.success(t("process.abortResumeToast", { page }));
  }

  const stopping = cancelling || !!activeJob?.cancel_requested;

  return (
    <StepBody>
      <div data-tour="process-bounds" className="relative flex flex-1 overflow-hidden">
        <PageStage
          imageUrl={imageUrl}
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
            tone: "bounds",
          }}
          toolbarExtras={
            <button
              type="button"
              onClick={toggleBoundsLock}
              disabled={!bounds}
              aria-pressed={boundsLocked}
              title={t("process.lockHint")}
              className={`inline-flex h-[38px] cursor-pointer items-center gap-[7px] rounded-lg border border-rule px-3 text-[13px] font-semibold transition-colors disabled:cursor-default disabled:opacity-50 ${
                boundsLocked ? "bg-gold-wash text-gold-text" : "bg-sheet text-ink-2 hover:bg-sunk"
              }`}
            >
              {boundsLocked ? (
                <Lock size={14} strokeWidth={2.4} aria-hidden="true" />
              ) : (
                <LockOpen size={14} aria-hidden="true" />
              )}
              {boundsLocked ? t("process.boundsLockedButton") : t("process.lockBounds")}
            </button>
          }
          overlay={
            activeJob?.run_id ? (
              <RunLogDock
                mushafId={mushafId}
                runId={activeJob.run_id}
                onExpand={() => setLogOpen(true)}
              />
            ) : null
          }
          onNatural={setNatural}
          processed={pages?.processed}
          reviewed={pages?.reviewed}
        />
        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.process")}
          onReplayTour={tour.start}
        />
      </div>

      <Aside
        wide
        status={status}
        footer={
          activeJob ? (
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => setCancelConfirmOpen(true)}
                disabled={stopping}
                className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-control border-[1.5px] border-stop bg-transparent text-[14px] font-semibold text-stop-text transition-colors hover:bg-stop-wash disabled:cursor-default disabled:opacity-60"
              >
                {stopping ? (
                  <BusyLabel>{t("process.cancelling")}</BusyLabel>
                ) : (
                  <>
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
                    {t("process.cancelButton")}
                  </>
                )}
              </button>
              <span className="text-center text-[12.5px] text-ink-3">
                {t("process.cancelConfirmIntro")}
              </span>
            </div>
          ) : (
            <div data-tour="process-run" className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!canProcess}
                className="inline-flex h-[46px] cursor-pointer items-center justify-center rounded-control bg-lapis text-[15px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50"
              >
                {starting ? (
                  <BusyLabel>{t("process.starting")}</BusyLabel>
                ) : (
                  t("process.processButton", { start: rangeStart, end: rangeEnd })
                )}
              </button>
              {completed && (
                <Link
                  to="/mushafs/$mushafId/review"
                  params={{ mushafId }}
                  search={{ page: rangeStart }}
                  className="inline-flex h-11 items-center justify-center rounded-control border border-rule-2 text-[14px] font-semibold text-ink-3 no-underline transition-colors hover:bg-card hover:text-ink"
                >
                  {t("process.continueReview")}
                </Link>
              )}
              {(job?.run_id || aborted || failed) && (
                <span className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                  {job?.run_id && (
                    <FooterLink onClick={() => setLogOpen(true)}>
                      {runNumber != null
                        ? t("process.logViewRun", { n: runNumber })
                        : t("process.logView")}
                    </FooterLink>
                  )}
                  {(aborted || failed) && (
                    <FooterLink onClick={() => setDetailsOpen(true)}>
                      {t("process.abortDetails")}
                    </FooterLink>
                  )}
                </span>
              )}
            </div>
          )
        }
      >
        {activeJob ? (
          <>
            <RunCard job={activeJob} runNumber={runNumber} />
            <Note icon={<Info size={15} aria-hidden="true" />}>{t("process.runningNote")}</Note>
          </>
        ) : (
          <>
            {settledJob && stopped && (
              <div ref={outcomeRef} className="scroll-mt-2">
                <OutcomeCard
                  kind={cancelled ? "cancelled" : failed ? "error" : "abort"}
                  stoppedOn={settledJob.stopped_on_page}
                  pagesSaved={settledJob.pages_saved}
                  error={settledJob.error}
                  onDetails={failed || aborted ? () => setDetailsOpen(true) : undefined}
                  onResume={settledJob.stopped_on_page != null ? resumeFromStop : undefined}
                />
              </div>
            )}

            {loadedRun && (
              <Note icon={<RotateCcw size={15} aria-hidden="true" />}>
                {loadedRun.from
                  ? t("process.loadedRunResume", { label: loadedRun.label, from: loadedRun.from })
                  : t("process.loadedRun", { label: loadedRun.label })}
              </Note>
            )}

            <Card title={t("process.boundsTitle")} end={<InfoTip text={t("process.boundsHelp")} />}>
              <RectInputs
                rect={bounds}
                onChange={setBounds}
                max={natural}
                disabled={boundsLocked}
              />
              {!boundsOk && (
                <span className="text-[12.5px] text-stop-text">{t("process.boundsError")}</span>
              )}
              {flipPreview && (
                <span className="text-[12.5px] leading-normal text-gold-text">
                  {t("process.flipHint", { page: preview, start: rangeStart })}
                </span>
              )}
              <button
                type="button"
                onClick={togglePreview}
                aria-expanded={previewOpen}
                className="flex cursor-pointer items-center gap-1.5 self-start text-[13px] font-semibold text-lapis-text hover:underline"
              >
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  className={`transition-transform ${previewOpen ? "" : "-rotate-90 rtl:rotate-90"}`}
                />
                {previewOpen ? t("process.previewHide") : t("process.previewShow")}
              </button>
              {previewOpen && (
                <CropPreview
                  imageUrl={imageUrl}
                  rect={bounds}
                  height={260}
                  mirrored={flipPreview}
                  caption={flipPreview ? t("canvas.tpl_mirroredCaption") : undefined}
                />
              )}
            </Card>

            <div data-tour="process-range">
              <Card title={t("process.rangeAndStart")}>
                <div className="grid grid-cols-2 gap-2">
                  <Labelled label={t("process.startPage")} info={t("tips.pageRange")}>
                    <NumInput
                      value={rangeStart}
                      min={1}
                      max={logicalCount}
                      onChange={setRangeStart}
                    />
                  </Labelled>
                  <Labelled label={t("process.endPage")}>
                    <NumInput value={rangeEnd} min={1} max={logicalCount} onChange={setRangeEnd} />
                  </Labelled>
                </div>
                <div data-tour="process-start" className="grid grid-cols-2 gap-2">
                  <Labelled label={t("process.startSura")} info={t("tips.startSura")}>
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
                  </Labelled>
                  <Labelled label={t("process.startAya")} info={t("tips.startAya")}>
                    <select
                      value={startAya}
                      onChange={(e) => setStartAya(Number(e.target.value))}
                      className={`${selectClass} font-mono`}
                    >
                      {Array.from({ length: ayaMax }, (_, i) => i + 1).map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </Labelled>
                </div>
                {rangeOk ? (
                  <span className="text-[12.5px] text-ink-3">
                    {t("process.rangeCount", { count: pageCount })}
                  </span>
                ) : (
                  <span className="text-[12.5px] text-stop-text">
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
                    action={t("process.firstRunApplyShort", {
                      start: rangeStart,
                      end: suggestedEnd,
                    })}
                    detail={t("process.firstRunBody", { count: pageCount })}
                    onApply={() => setRangeEnd(suggestedEnd)}
                  />
                )}
              </Card>
            </div>

            <div data-tour="process-settings">
              <SettingsCard settings={settings} onChange={setSettings} />
            </div>
          </>
        )}
      </Aside>

      {bounds && (
        <ProcessConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={() => {
            setConfirmOpen(false);
            void startRun();
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
          imageUrl={imageUrl}
          natural={natural}
          firstRun={firstRunRisky}
          earlyPages={earlyPages}
        />
      )}

      {activeJob && (
        <ProcessCancelDialog
          open={cancelConfirmOpen}
          onOpenChange={setCancelConfirmOpen}
          onConfirm={() => void cancelRun()}
          job={activeJob}
        />
      )}

      {job?.run_id && (
        <RunLogDialog
          open={logOpen}
          onOpenChange={setLogOpen}
          mushafId={mushafId}
          runId={job.run_id}
          runNumber={runNumber}
          live={running}
        />
      )}

      {settledJob && (aborted || failed) && (
        <ProcessAbortDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          kind={aborted ? "abort" : "error"}
          info={settledJob.abort_info}
          page={settledJob.stopped_on_page}
          pagesSaved={settledJob.pages_saved}
          logUrl={settledJob.log_url}
          errorMessage={settledJob.error}
          onResume={settledJob.stopped_on_page != null ? resumeFromStop : undefined}
        />
      )}

      <TourOverlay tour={tour} />
    </StepBody>
  );
}

const selectClass =
  "h-9 w-full min-w-0 cursor-pointer rounded-control border border-rule-2 bg-card px-1.5 text-[13.5px] text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)]";

/** What the run is doing right now, named after the page it is on — the phase
 * changes several times per page, so this is also the "it hasn't hung" signal. */
function phaseLabel(t: TFunction, job: ProcessJob): string {
  const page = job.current_page;
  if (page == null) return t("process.processing");
  switch (job.phase) {
    case "rendering":
      return t("process.phaseRendering", { page });
    case "detecting":
      return t("process.phaseDetecting", { page });
    case "saving":
      return t("process.phaseSaving", { page });
    default:
      return t("process.processing");
  }
}

/** The run in flight, on deep lapis: which run and range, the pages saved as a
 * figure and a gold bar, and what it is doing on which page. */
function RunCard({ job, runNumber }: { job: ProcessJob; runNumber?: number }) {
  const { t } = useTranslation();
  const pct = job.total > 0 ? Math.round((job.pages_saved / job.total) * 100) : 0;
  const range = { start: job.page_range_start, end: job.page_range_end };
  return (
    <section className="flex flex-col gap-3.5 rounded-panel bg-deep p-[18px] text-on-deep">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-on-deep-2">
          {runNumber != null
            ? t("process.runCardTitle", { n: runNumber, ...range })
            : t("process.runCardRange", range)}
        </span>
        <span className="font-mono text-[12px] text-on-deep-2">{pct}%</span>
      </div>
      <div className="flex items-baseline gap-2.5">
        <span className="font-display text-[44px] font-semibold leading-none">
          {job.pages_saved}
        </span>
        <span className="text-[15px] text-on-deep-2">
          {t("process.runCardSaved", { total: job.total })}
        </span>
      </div>
      <div className="h-2 rounded bg-white/15">
        <div className="h-2 rounded bg-gold" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[13px] text-on-deep-2">
        {job.cancel_requested ? t("process.cancelling") : phaseLabel(t, job)}
      </span>
    </section>
  );
}

/** A card of the inspector: the small uppercase title (with anything at its end),
 * then the controls. */
function Card({ title, end, children }: { title: string; end?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-card border border-rule bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {title}
        </h2>
        {end}
      </div>
      {children}
    </section>
  );
}

/** A lapis note with its icon: what was loaded, or that the run is on the server. */
function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2.5 rounded-lg bg-lapis-wash px-3 py-2.5 text-[13px] leading-normal text-lapis-text">
      <span className="mt-0.5 flex-none">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

function FooterLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer text-[13px] font-semibold text-lapis-text hover:underline"
    >
      {children}
    </button>
  );
}

/** Panel-side summary of a stopped run. The evidence itself lives in the dialog —
 * this card only has to be impossible to miss and one click away from it.
 *
 * A cancel is not a failure: same anatomy, neutral colours, and it leads with
 * what was kept rather than what broke. */
function OutcomeCard({
  kind,
  stoppedOn,
  pagesSaved,
  error,
  onDetails,
  onResume,
}: {
  kind: "abort" | "cancelled" | "error";
  stoppedOn: number | null;
  pagesSaved: number;
  error: string | null;
  onDetails?: () => void;
  onResume?: () => void;
}) {
  const { t } = useTranslation();
  const neutral = kind === "cancelled";
  const shell = neutral ? "border border-rule bg-card text-ink-2" : "bg-stop-wash text-stop-text";
  const title =
    kind === "error"
      ? t("process.errorDialogTitle")
      : kind === "cancelled"
        ? t("process.cancelledTitle")
        : t("process.abortTitle");
  const lead =
    kind === "error"
      ? error
      : kind === "cancelled"
        ? t("process.cancelledLead", { page: stoppedOn ?? "?" })
        : t("process.abortLead", { page: stoppedOn ?? "?" });
  const action =
    "inline-flex h-8 cursor-pointer items-center rounded-control border border-current/25 bg-card px-2.5 text-[12.5px] font-semibold text-ink transition-colors hover:bg-sheet";

  return (
    <div className={`flex flex-col gap-2 rounded-card px-3.5 py-3 text-[13px] ${shell}`}>
      <div className="flex items-center gap-2 font-semibold">
        {neutral ? (
          <OctagonX size={15} className="flex-none" aria-hidden="true" />
        ) : (
          <TriangleAlert size={15} className="flex-none" aria-hidden="true" />
        )}
        {title}
      </div>
      <div className="leading-normal">{lead}</div>
      <div className="font-mono text-[12px]">
        {t("process.abortSavedCount", { count: pagesSaved })}
      </div>
      <div className="flex flex-wrap gap-2">
        {onDetails && (
          <button type="button" onClick={onDetails} className={action}>
            {t("process.abortDetails")}
          </button>
        )}
        {onResume && stoppedOn != null && (
          <button type="button" onClick={onResume} className={action}>
            {t("process.abortResume", { page: stoppedOn })}
          </button>
        )}
      </div>
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
    <div className="flex items-start gap-1.5 text-[12.5px] leading-normal text-warn-text">
      <TriangleAlert size={13} className="mt-[3px] flex-none" aria-hidden="true" />
      <span>
        {text}{" "}
        <button
          type="button"
          onClick={onApply}
          className="cursor-pointer font-semibold underline underline-offset-2 hover:text-lapis-text"
        >
          {action}
        </button>{" "}
        <InfoTip text={detail} />
      </span>
    </div>
  );
}

/** A labelled control as the board draws it: the label above, its (i) beside it,
 * a hint under it. */
function Labelled({
  label,
  info,
  hint,
  children,
}: {
  label: string;
  info?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1 text-[12.5px] font-semibold text-ink-2">
        {label}
        {info && <InfoTip text={info} />}
      </span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-ink-4">{hint}</span>}
    </label>
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
    <Card
      title={t("process.detectionSettings")}
      end={<span className="text-[12px] text-ink-3">{t("process.settingsNote")}</span>}
    >
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        <Labelled
          label={t("process.padding")}
          hint={t("process.paddingHint")}
          info={t("tips.padding")}
        >
          <NumInput value={settings.padding} min={0} onChange={(v) => u({ padding: v })} compact />
        </Labelled>
        <Labelled
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
        </Labelled>
        <Labelled
          label={t("process.headerSlots")}
          hint={t("process.headerSlotsHint")}
          info={t("tips.headerSlots")}
        >
          <NumInput
            value={settings.sura_header_slots}
            min={1}
            onChange={(v) => u({ sura_header_slots: v })}
            compact
          />
        </Labelled>
        <Labelled
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
        </Labelled>
        <Labelled
          label={t("process.maxHeaders")}
          hint={t("process.maxHeadersHint")}
          info={t("tips.maxHeaders")}
        >
          <NumInput
            value={settings.max_sura_headers}
            min={1}
            onChange={(v) => u({ max_sura_headers: v })}
            compact
          />
        </Labelled>
        <Labelled
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
        </Labelled>
      </div>
      <div className="flex flex-col gap-2 border-t border-rule-soft pt-1.5">
        <ToggleRow
          label={t("process.altMargins")}
          hint={t("process.altMarginsHint")}
          info={t("tips.altMargins")}
          value={settings.alternate_horizontal_margin}
          onChange={(v) => u({ alternate_horizontal_margin: v })}
        />
        <ToggleRow
          label={t("process.preferAccel")}
          hint={t("process.preferAccelHint")}
          info={t("tips.preferAccel")}
          value={settings.prefer_acceleration}
          onChange={(v) => u({ prefer_acceleration: v })}
        />
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  hint,
  info,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  info: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2.5">
      <span className="flex flex-col">
        <span className="flex items-center gap-1 text-[13.5px] font-medium text-ink">
          {label}
          <InfoTip text={info} />
        </span>
        <span className="text-[12px] text-ink-3">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`relative h-[22px] w-[38px] flex-none cursor-pointer rounded-pill transition-colors ${
          value ? "bg-lapis" : "bg-rule-2"
        }`}
      >
        <span
          className={`absolute top-[3px] h-4 w-4 rounded-full bg-card shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-all ${
            value ? "end-[3px]" : "start-[3px]"
          }`}
        />
      </button>
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
      className={`${compact ? "h-[34px] text-[13.5px]" : "h-9 text-[14px]"} w-full min-w-0 rounded-control border border-rule-2 bg-card px-2.5 font-mono font-medium text-ink outline-none focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)]`}
    />
  );
}

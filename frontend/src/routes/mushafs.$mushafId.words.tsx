import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker, useNavigate, useParams } from "@tanstack/react-router";
import { OctagonX, Play, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CanvasHelp } from "@/components/app/CanvasHelp";
import { Aside, Field, Hint, PanelCard, Section, StatusLine } from "@/components/app/Panel";
import { ProcessCancelDialog } from "@/components/app/ProcessCancelDialog";
import { RunLogDialog } from "@/components/app/RunLogDialog";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { WordsCanvas } from "@/components/canvas/WordsCanvas";
import { revealInScroller } from "@/lib/reveal";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  cancelWordDetection,
  isJobRunning,
  isJobSettled,
  pageImageUrl,
  queryKeys,
  savePageWords,
  startWordDetection,
  useMushaf,
  usePage,
  usePageWords,
  useProcessedPages,
  useSuras,
  useWordsCoverage,
  useWordsJob,
  useWordsSpan,
  type CoherenceIssue,
  type DetectWordsRequest,
  type PageWords,
  type ProcessJob,
  type WordSpanGap,
} from "@/lib/api";
import {
  addCut,
  canMoveLine,
  insertWordAfter,
  moveWordToLine,
  baselineOf,
  buildModel,
  dirtyLines,
  flaggedLines,
  lineSignature,
  holdsWords,
  moveBox,
  needsReview,
  removeCut,
  savePayload,
  stretchesWithCounts,
  toggleUnlabelled,
  type BoxGrab,
  type BoxHandle,
  type EditLine,
  type WordsModel,
} from "@/lib/words/model";

export const Route = createFileRoute("/mushafs/$mushafId/words")({
  validateSearch: (s: Record<string, unknown>) => ({ page: Math.max(1, Number(s.page) || 1) }),
  component: WordsPage,
});

const HISTORY_LIMIT = 100;
const EMPTY: WordsModel = { lines: [], labels: new Map(), pins: [] };

/** How much of the mushaf one run covers.
 *
 * Three named cases rather than a pair of ayat and a checkbox, because the three
 * are asked for differently and only one of them is the user's to fill in: a sura
 * run leaves the end to the server (a sura's last aya is not the same number in
 * every riwaya), a mushaf run leaves both ends to it, and only `range` is typed. */
type RunScope = "sura" | "range" | "mushaf";

function WordsPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/words" });
  const { page } = Route.useSearch();
  const navigate = useNavigate({ from: "/mushafs/$mushafId/words" });
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const { data: mushaf } = useMushaf(mushafId);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: coverage } = useWordsCoverage(mushafId);
  const { data: span } = useWordsSpan(mushafId);
  const { data: job } = useWordsJob(mushafId);

  const ready = !!pages?.processed.has(page) && !!pages.reviewed.has(page);
  const { data: pageData } = usePage(mushafId, page, ready);
  const { data: pageWords } = usePageWords(mushafId, page, ready);

  const [model, setModel] = useState<WordsModel>(EMPTY);
  const [baseline, setBaseline] = useState<Map<string, string>>(new Map());
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [selectedCut, setSelectedCut] = useState<string | null>(null);
  // The three ways a run is asked for. `sura` is the common one and stays the
  // default; `range` spans any two ayat, in one sura or across many; `mushaf` is
  // whatever the server says this mushaf actually holds — see `useWordsSpan`.
  const [scope, setScope] = useState<RunScope>("sura");
  const [fromSura, setFromSura] = useState(1);
  const [fromAya, setFromAya] = useState(1);
  const [toSura, setToSura] = useState(1);
  const [toAya, setToAya] = useState(1);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [issues, setIssues] = useState<CoherenceIssue[]>([]);
  /** Breaks the last run started here stepped over. Kept on screen rather than
   * toasted: on a whole-mushaf run this is the list of what was NOT read, and it
   * is the thing to go and fix. Cleared when a new run is asked for. */
  const [gaps, setGaps] = useState<WordSpanGap[]>([]);

  // Latest model, for handlers that outlive the render they were created in —
  // see `onMoveCommit`.
  const modelRef = useRef(model);
  modelRef.current = model;

  // ── undo/redo (one entry per committed edit) ───────────────────────────────
  const historyRef = useRef<{ stack: WordsModel[]; index: number }>({ stack: [], index: -1 });
  const [, bumpHistory] = useState(0);
  const forceHistory = () => bumpHistory((n) => n + 1);

  const commit = useCallback((next: WordsModel) => {
    setModel(next);
    const h = historyRef.current;
    const stack = h.stack.slice(0, h.index + 1);
    stack.push(next);
    while (stack.length > HISTORY_LIMIT) stack.shift();
    historyRef.current = { stack, index: stack.length - 1 };
    forceHistory();
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    historyRef.current = { stack: h.stack, index: h.index - 1 };
    setModel(h.stack[h.index - 1]);
    forceHistory();
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    historyRef.current = { stack: h.stack, index: h.index + 1 };
    setModel(h.stack[h.index + 1]);
    forceHistory();
  }, []);

  /** The page the model was built from, and the exact answer it was built from.
   *
   * Identity rather than a page number, because *when* a rebuild is allowed is
   * the whole question. A finished run — or one finished chunk of one —
   * invalidates this page's query, and invalidating only *starts* a refetch:
   * a page-number flag cleared at that moment rebuilt from the data still in
   * the cache, then refused the fresh answer when it landed, because the flag
   * by then said that page was built. Hence the browser reload. */
  const builtRef = useRef<{ page: number; signature: string } | null>(null);
  /** The page whose fresh answer is being withheld because it has unsaved
   * edits. Held, not dropped — saving is what finally lets it in. */
  const heldRef = useRef<number | null>(null);

  // Build whenever the server's answer differs from the one behind the model.
  useEffect(() => {
    if (!ready || !pageWords || !pageData) return;
    const signature = JSON.stringify(pageWords);
    const built = builtRef.current;
    const samePage = built?.page === page;
    // Nothing changed: a poll, a refocus, or a chunk that landed on some other
    // page. Rebuilding here would cost the reviewer their selection and their
    // undo history for no news at all.
    if (samePage && built?.signature === signature) return;
    // Changed, but there are unsaved edits here: hold. A run over one sura can
    // land on a page being edited in another, and rebuilding would drop that
    // work without asking. The ref is deliberately left stale, so the answer is
    // taken as soon as the edits are saved rather than lost.
    if (samePage && dirtyRef.current.length > 0) {
      heldRef.current = page;
      return;
    }

    heldRef.current = null;
    const next = buildModel(pageWords, pageData.lines);
    setModel(next);
    historyRef.current = { stack: [next], index: 0 };
    forceHistory();
    setBaseline(baselineOf(next.lines));
    setIssues(pageWords.issues);
    // Keep the line being read when the rebuild still has it: a chunk arriving
    // mid-review must not throw the reviewer back to the top of the page. Cut
    // uids are minted per build, so that selection cannot be kept.
    setSelectedLine((prev) =>
      prev && next.lines.some((l) => l.line_id === prev)
        ? prev
        : ((next.lines.find(needsReview) ?? next.lines.find(holdsWords))?.line_id ?? null),
    );
    setSelectedCut(null);
    builtRef.current = { page, signature };
  }, [ready, pageWords, pageData, page]);

  useEffect(() => {
    if (!ready && builtRef.current) {
      setModel(EMPTY);
      builtRef.current = null;
    }
  }, [ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never while the sura picker or an aya field has focus.
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing) return;

      if (!(e.ctrlKey || e.metaKey)) {
        if ((e.key === "Delete" || e.key === "Backspace") && selectedLine && selectedCut) {
          e.preventDefault();
          onRemoveCut(selectedLine, selectedCut);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // No dependency array: the handler reads the current selection, and every
    // value it closes over is rebuilt each render anyway.
  });

  const dirty = useMemo(() => dirtyLines(model.lines, baseline), [model, baseline]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const flagged = useMemo(() => flaggedLines(model.lines), [model.lines]);
  const stretches = useMemo(() => stretchesWithCounts(model), [model]);
  const line = model.lines.find((l) => l.line_id === selectedLine) ?? null;

  // Unlike Finalize, this blocks a *page* change too, not just leaving the step:
  // the model is rebuilt per page, so paging away with unsaved cuts would drop
  // them without a word.
  useBlocker({
    enableBeforeUnload: () => dirty.length > 0,
    shouldBlockFn: ({ current, next }) => {
      if (!dirty.length) return false;
      if (current.pathname === next.pathname && searchPage(current) === searchPage(next)) {
        return false;
      }
      return !window.confirm(t("words.leaveConfirm"));
    },
  });

  // ── editing ────────────────────────────────────────────────────────────────
  const onAddCut = (lineId: string, x: number) => {
    const next = addCut(model, lineId, x);
    if (next) commit(next);
  };

  /** The panel's insert, for a word the engine missed in the gap between two boxes,
   * where there is nothing on the page to double-click. It takes the next word of
   * the text; ∅ on the new row is what makes it one the text does not have. */
  const onInsertWord = (lineId: string, afterUid: string) => {
    const next = insertWordAfter(model, lineId, afterUid);
    if (next) commit(next);
  };

  /** The fix for a line break in the wrong place. Adding and removing cuts shifts
   * labels along *within* an aya, but the renumber stops at the ornament — and a
   * misplaced break tends to sit exactly there — so the word moves line instead. */
  const onMoveWordLine = (lineId: string, cutUid: string, step: -1 | 1) => {
    const next = moveWordToLine(model, lineId, cutUid, step);
    if (!next) return;
    commit(next);
    setSelectedCut(cutUid);
    const to = next.lines.find((l) => l.cuts.some((c) => c.uid === cutUid));
    if (to) setSelectedLine(to.line_id);
  };

  const onRemoveCut = (lineId: string, cutUid: string) => {
    commit(removeCut(model, lineId, cutUid));
    setSelectedCut(null);
  };

  /** Live during a drag: state only, no history entry — the commit lands on
   * pointer-up, so one drag is one undo step. */
  const onMoveBox = (
    lineId: string,
    cutUid: string,
    handle: BoxHandle,
    x: number,
    grab: BoxGrab | undefined,
  ) => {
    setModel((m) => moveBox(m, lineId, cutUid, handle, x, grab) ?? m);
  };

  // Through the ref, not through `model`: the canvas registers its pointer-up
  // listener when the drag *starts*, so a closure over `model` would push the
  // pre-drag state onto the history — and setModel it back, undoing the drag.
  const onMoveCommit = () => commit(modelRef.current);

  // ── saving ─────────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Captured here, not read again in onSuccess: an edit made while the
      // request is in flight must stay dirty, and re-reading `dirty` on the way
      // back would mark it saved.
      const sent = dirtyLines(modelRef.current.lines, baseline);
      const fresh = await savePageWords(mushafId, page, savePayload(sent));
      return { sent, fresh };
    },
    onSuccess: ({ sent, fresh }) => {
      queryClient.setQueryData(queryKeys.pageWords(mushafId, page), fresh);
      // Normally recorded as built without rebuilding: this answer is the
      // model's own edit coming back, and leaving it unrecorded would rebuild
      // off every save, costing the selection and the undo history each time.
      // The exception is a run that landed while these edits were open — it is
      // in `fresh` too, and now that the edits are safe it can finally be taken.
      if (heldRef.current === page) heldRef.current = null;
      else builtRef.current = { page, signature: JSON.stringify(fresh) };
      setIssues(fresh.issues);
      setBaseline((prev) => {
        const next = new Map(prev);
        for (const l of sent) next.set(l.line_id, lineSignature(l));
        return next;
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.wordsCoverage(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
      toast.success(t("words.savedToast", { count: sent.length }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("words.saveFailed")),
  });

  // ── the run ────────────────────────────────────────────────────────────────
  const ayaCountOf = useCallback(
    (n: number) => suras?.find((s) => s.number === n)?.aya_count ?? 1,
    [suras],
  );
  const fromAyaCount = ayaCountOf(fromSura);
  const toAyaCount = ayaCountOf(toSura);

  /** The request this panel is currently describing, or null when it cannot yet.
   *
   * Only `mushaf` can be null, and only until `useWordsSpan` answers: the whole
   * mushaf is the one span this screen does not know the ends of. A mushaf nothing
   * has renumbered has no ends at all, and the button says so rather than sending a
   * request the server would refuse. */
  const request = useMemo((): DetectWordsRequest | null => {
    if (scope === "sura") return { from_sura: fromSura };
    if (scope === "range") {
      return { from_sura: fromSura, from_aya: fromAya, to_sura: toSura, to_aya: toAya };
    }
    if (!span?.start || !span.end) return null;
    return {
      from_sura: span.start.sura,
      from_aya: span.start.aya,
      to_sura: span.end.sura,
      to_aya: span.end.aya,
    };
  }, [scope, fromSura, fromAya, toSura, toAya, span]);

  const runMutation = useMutation({
    mutationFn: () => {
      if (!request) throw new Error(t("words.spanUnknown"));
      return startWordDetection(mushafId, request);
    },
    onSuccess: (result) => {
      // Seed the cache with the job the POST returned so progress shows at once,
      // rather than after the first poll.
      queryClient.setQueryData(queryKeys.wordsJob(mushafId), result.job);
      // Gaps are the one warning worth holding on screen: on a long span they say
      // which part of the mushaf was skipped, and a toast that fades takes the
      // answer with it. The rest still pass through as toasts.
      setGaps(result.gaps);
      result.warnings
        .filter((w) => !result.gaps.some((gap) => w.includes(gap.after) && w.includes(gap.before)))
        .forEach((w) => toast.warning(w));
      toast.info(t("words.runStarted", { lines: result.total_lines }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("words.runFailed")),
  });

  // Announce a settled run once, and refresh what it changed.
  //
  // Only a run this page actually watched finish: `/words/job` answers with the
  // most recent run whether or not it is still going, so without the first guard
  // every visit would toast the last run again and rebuild the page for nothing.
  const watchedRef = useRef<string | null>(null);
  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (isJobRunning(job)) {
      watchedRef.current = job.id;
      return;
    }
    if (!isJobSettled(job) || watchedRef.current !== job.id) return;
    if (announcedRef.current === job.id) return;
    announcedRef.current = job.id;
    queryClient.invalidateQueries({ queryKey: queryKeys.wordsCoverage(mushafId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.pageWords(mushafId, page) });
    // Only the announcement is decided here. The page rebuilds when the refetch
    // those invalidations started actually lands — see `builtRef`, which also
    // holds the rebuild back while there are unsaved edits to lose.
    if (dirtyRef.current.length > 0) toast.info(t("words.runRefreshHeld"));
    if (job.state === "completed") toast.success(t("words.runDone", { lines: job.lines_done }));
    else if (job.state === "cancelled")
      toast.info(t("words.runCancelled", { lines: job.lines_done }));
    else if (job.error) toast.error(job.error);
  }, [job, mushafId, page, queryClient, t]);

  // Show each chunk as it lands, rather than only the finished run.
  //
  // `word_runs.run` stores a chunk in its own transaction and only *then* ticks
  // `lines_done` — so the counter moving means those rows are committed and
  // readable, once per chunk. On a whole-sura run that is the difference between
  // reading a page now and reading it a minute and a half from now.
  const progressRef = useRef(-1);
  useEffect(() => {
    if (!job || !isJobRunning(job) || job.lines_done === progressRef.current) return;
    progressRef.current = job.lines_done;
    // The rail's "which pages hold words" comes from coverage, so it moves too.
    queryClient.invalidateQueries({ queryKey: queryKeys.wordsCoverage(mushafId) });
    // A page the run will never touch has no news for us.
    if (page < job.page_range_start || page > job.page_range_end) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.pageWords(mushafId, page) });
  }, [job, mushafId, page, queryClient]);

  const running = isJobRunning(job);

  // ── coverage, for the rail and the "next page worth a look" jump ────────────
  const { withWords, clean, flaggedPages } = useMemo(() => {
    const rows = coverage?.pages ?? [];
    return {
      withWords: new Set(rows.filter((p) => p.lines_with_words > 0).map((p) => p.page)),
      clean: new Set(rows.filter((p) => p.complete && p.needs_review === 0).map((p) => p.page)),
      flaggedPages: rows.filter((p) => p.needs_review > 0).map((p) => p.page),
    };
  }, [coverage]);

  const goToPage = (n: number) =>
    navigate({ search: { page: Math.max(1, Math.min(mushaf?.logical_page_count ?? 1, n)) } });

  /** Step through flagged lines, rolling onto the next flagged page at the end.
   * This is the whole promise of storing a verdict: 136 lines instead of 3,320
   * words, and never a page read top to bottom unless the reviewer wants to. */
  const stepFlagged = (delta: 1 | -1) => {
    const index = flagged.findIndex((l) => l.line_id === selectedLine);
    const next = flagged[index + delta];
    if (next) {
      setSelectedLine(next.line_id);
      setSelectedCut(null);
      return;
    }
    const candidates =
      delta > 0 ? flaggedPages.filter((p) => p > page) : flaggedPages.filter((p) => p < page);
    const target = delta > 0 ? candidates[0] : candidates[candidates.length - 1];
    if (target) goToPage(target);
    else toast.info(t("words.noMoreFlagged"));
  };

  const tourSteps: TourStep[] = [
    { target: "words-run", title: t("tour.words.t1_title"), body: t("tour.words.t1_body") },
    { target: "canvas-toolbar", title: t("tour.words.t2_title"), body: t("tour.words.t2_body") },
    { target: "words-canvas", title: t("tour.words.t3_title"), body: t("tour.words.t3_body") },
    { target: "words-triage", title: t("tour.words.t4_title"), body: t("tour.words.t4_body") },
  ];
  const tour = useStepTour("words", tourSteps, !coverage?.complete);

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;

  const status = running ? (
    <RunProgress job={job!} />
  ) : !ready ? (
    <StatusLine tone="warning">{t("words.gateStatus", { page })}</StatusLine>
  ) : dirty.length ? (
    <StatusLine>{t("words.unsavedStatus", { count: dirty.length })}</StatusLine>
  ) : flagged.length ? (
    <StatusLine tone="action">{t("words.flaggedStatus", { count: flagged.length })}</StatusLine>
  ) : (
    <StatusLine tone="success">{t("words.cleanStatus")}</StatusLine>
  );

  const guideItems = [
    t("guide.words.s1"),
    t("guide.words.s2"),
    t("guide.words.s3"),
    t("guide.words.s4"),
    t("guide.words.s5"),
    t("guide.words.s6"),
    t("guide.words.s7"),
  ];

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <div data-tour="words-canvas" className="relative flex flex-1 overflow-hidden">
        {ready ? (
          <WordsCanvas
            imageUrl={pageImageUrl(mushafId, page, mushaf.updated_at)}
            lines={model.lines}
            selectedLine={selectedLine}
            selectedCut={selectedCut}
            onSelectLine={(id) => {
              setSelectedLine(id);
              setSelectedCut(null);
            }}
            onSelectCut={(id, uid) => {
              setSelectedLine(id);
              setSelectedCut(uid);
            }}
            onAddCut={onAddCut}
            onMoveBox={onMoveBox}
            onMoveCommit={onMoveCommit}
            onRemoveCut={onRemoveCut}
            onUndo={undo}
            onRedo={redo}
            canUndo={historyRef.current.index > 0}
            canRedo={historyRef.current.index < historyRef.current.stack.length - 1}
            page={page}
            pageCount={logicalCount}
            onPageChange={goToPage}
            withWords={withWords}
            clean={clean}
            isRTL={i18n.language === "ar"}
            statusSlot={
              <span className="text-[11px] text-text-muted">
                {t("words.lineCount", { count: model.lines.filter(holdsWords).length })}
              </span>
            }
          />
        ) : (
          <GateNotice mushafId={mushafId} page={page} processed={!!pages?.processed.has(page)} />
        )}
        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.words")}
          onReplayTour={tour.start}
        />
      </div>

      <Aside
        status={status}
        footer={
          <div className="flex gap-2">
            {running ? (
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setCancelOpen(true)}
                disabled={job?.cancel_requested}
              >
                <OctagonX size={14} />
                {job?.cancel_requested ? t("words.stopping") : t("words.stopRun")}
              </Button>
            ) : (
              <Button
                className="flex-1"
                onClick={() => saveMutation.mutate()}
                disabled={!dirty.length || saveMutation.isPending}
              >
                {saveMutation.isPending ? t("common.saving") : t("words.savePage")}
              </Button>
            )}
          </div>
        }
      >
        <Section title={t("words.runTitle")} defaultOpen={!coverage?.pages.length}>
          <div data-tour="words-run" className="flex flex-col gap-3">
            <Field label={t("words.scopeLabel")} info={t("tips.wordsSpan")}>
              <select
                className={selectClass}
                value={scope}
                disabled={running}
                onChange={(e) => {
                  const next = e.target.value as RunScope;
                  setScope(next);
                  // Open the range on the whole of the sura already picked, so
                  // switching to it starts from something valid and shrinks,
                  // rather than from 1:1..1:1 and having to be built up.
                  if (next === "range") {
                    setFromAya(1);
                    setToSura(fromSura);
                    setToAya(ayaCountOf(fromSura));
                  }
                }}
              >
                <option value="sura">{t("words.scopeSura")}</option>
                <option value="range">{t("words.scopeRange")}</option>
                <option value="mushaf">{t("words.scopeMushaf")}</option>
              </select>
            </Field>

            {scope !== "mushaf" && (
              <Field label={scope === "sura" ? t("words.suraLabel") : t("words.fromSura")}>
                <select
                  className={selectClass}
                  value={fromSura}
                  disabled={running}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setFromSura(n);
                    setFromAya(1);
                    // A range can only run forwards. Dragging the start past the
                    // end takes the end with it rather than leaving a span the
                    // server would refuse.
                    if (toSura < n) {
                      setToSura(n);
                      setToAya(ayaCountOf(n));
                    }
                  }}
                >
                  {(suras ?? []).map((s) => (
                    <option key={s.number} value={s.number}>
                      {s.number}. {s.transliteration}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {scope === "range" && (
              <>
                <Field label={t("words.fromAya")}>
                  <input
                    type="number"
                    min={1}
                    max={fromAyaCount}
                    value={fromAya}
                    disabled={running}
                    onChange={(e) => setFromAya(clamp(Number(e.target.value), 1, fromAyaCount))}
                    className={numberClass}
                  />
                </Field>
                <Field label={t("words.toSura")}>
                  <select
                    className={selectClass}
                    value={toSura}
                    disabled={running}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setToSura(n);
                      // Through the end of the sura just picked, which is what
                      // someone choosing a new end sura nearly always means.
                      setToAya(ayaCountOf(n));
                    }}
                  >
                    {(suras ?? [])
                      .filter((s) => s.number >= fromSura)
                      .map((s) => (
                        <option key={s.number} value={s.number}>
                          {s.number}. {s.transliteration}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={t("words.toAya")}>
                  <input
                    type="number"
                    min={toSura === fromSura ? fromAya : 1}
                    max={toAyaCount}
                    value={toAya}
                    disabled={running}
                    onChange={(e) =>
                      setToAya(
                        clamp(
                          Number(e.target.value),
                          toSura === fromSura ? fromAya : 1,
                          toAyaCount,
                        ),
                      )
                    }
                    className={numberClass}
                  />
                </Field>
              </>
            )}

            {/* What a whole-mushaf run will actually cover. Shown rather than
                assumed to be 1:1 .. 114:6, because a mushaf part way through
                review holds less, and that is the number worth seeing before
                starting something that runs for a quarter of an hour. */}
            {scope === "mushaf" && (
              <Hint tone={span?.start && span.end ? undefined : "warning"}>
                {span?.start && span.end
                  ? t("words.mushafSpan", {
                      from: `${span.start.sura}:${span.start.aya}`,
                      to: `${span.end.sura}:${span.end.aya}`,
                    })
                  : t("words.spanUnknown")}
              </Hint>
            )}

            <Button
              variant="outline"
              className="w-full"
              disabled={running || runMutation.isPending || !request}
              onClick={() => {
                setGaps([]);
                runMutation.mutate();
              }}
            >
              <Play size={14} />
              {running ? t("words.running") : t("words.runButton")}
            </Button>
            {/* `log_url` rather than the job's mere existence: a run started
                before this feature, or one whose log the retention sweep has
                since deleted, has nothing to open. */}
            {job?.log_url && (
              <Button variant="outline" className="w-full" onClick={() => setLogOpen(true)}>
                <ScrollText size={14} />
                {running ? t("words.logWatch") : t("words.logView")}
              </Button>
            )}
            {/* Kept until the next run is asked for. These name the pages the run
                could NOT read, which on a long span is the only place that answer
                exists — a toast would carry it off screen in four seconds. */}
            {gaps.length > 0 && (
              <Hint tone="warning">
                <span className="font-medium">{t("words.gapsTitle", { count: gaps.length })}</span>
                <ul className="mt-1 list-disc ps-4">
                  {gaps.map((gap) => (
                    <li key={`${gap.after}-${gap.before}`}>
                      {t("words.gapLine", {
                        after: gap.after,
                        afterPage: gap.after_page,
                        before: gap.before,
                        beforePage: gap.before_page,
                      })}
                    </li>
                  ))}
                </ul>
              </Hint>
            )}
            <p className="text-[10.5px] leading-snug text-text-muted">{t("words.runNote")}</p>
          </div>
        </Section>

        {!ready ? (
          <Hint tone="warning">{t("words.gateHint", { page })}</Hint>
        ) : (
          <>
            {/* Strips are drawn from the page's geometry, so a page the engine has
                never seen still renders — just with nothing on it. Say so here
                rather than leaving the reviewer to wonder. */}
            {model.lines.length > 0 && model.lines.every((l) => l.cuts.length === 0) && (
              <Hint>{t("words.noWords", { page })}</Hint>
            )}
            <div data-tour="words-triage">
              <PanelCard
                title={t("words.triageTitle", {
                  count: flagged.length,
                  total: model.lines.filter(holdsWords).length,
                })}
              >
                <div className="flex items-stretch gap-2">
                  <Button
                    variant="outline"
                    className="h-8 flex-1 text-[11px]"
                    onClick={() => stepFlagged(-1)}
                  >
                    {t("words.prevFlagged")}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-8 flex-1 text-[11px]"
                    onClick={() => stepFlagged(1)}
                  >
                    {t("words.nextFlagged")}
                  </Button>
                </div>
                {line ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[12px] font-semibold text-orange">
                      {t("words.linePosition", { n: line.line_number })}
                    </span>
                    <span className="text-[11.5px] text-text-secondary">
                      {line.status ? t(`words.status_${line.status}`) : t("words.status_none")}
                      {line.edited ? ` · ${t("words.editedChip")}` : ""}
                    </span>
                    {line.reason && (
                      <span className="text-[10.5px] leading-snug text-text-muted">
                        {line.reason}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="text-[12px] text-text-muted">{t("words.selectLine")}</p>
                )}
              </PanelCard>
            </div>

            {line && (
              <CutList
                line={line}
                selectedCut={selectedCut}
                onSelectCut={(uid) => setSelectedCut(uid)}
                onRemove={(uid) => onRemoveCut(line.line_id, uid)}
                onToggleUnlabelled={(uid) => commit(toggleUnlabelled(model, line.line_id, uid))}
                onInsertWord={(uid) => onInsertWord(line.line_id, uid)}
                canMove={(uid, step) => canMoveLine(model, line.line_id, uid, step)}
                onMoveLine={(uid, step) => onMoveWordLine(line.line_id, uid, step)}
              />
            )}

            {stretches.some((s) => s.words > 0 && s.cuts !== s.words) && (
              <Hint tone="warning">
                {t("words.countMismatch", {
                  count: stretches.filter((s) => s.words > 0 && s.cuts !== s.words).length,
                })}
              </Hint>
            )}

            {issues.length > 0 && (
              <PanelCard title={t("words.issuesTitle", { count: issues.length })}>
                <p className="-mt-1 text-[10.5px] leading-snug text-text-muted">
                  {t("words.issuesNote")}
                </p>
                <div className="flex flex-col gap-1.5">
                  {issues.slice(0, 20).map((issue, i) => (
                    <button
                      key={`${issue.kind}-${i}`}
                      type="button"
                      onClick={() => {
                        const target = model.lines.find((l) => l.line_number === issue.line_number);
                        if (target) setSelectedLine(target.line_id);
                      }}
                      className="flex cursor-pointer flex-col gap-0.5 rounded border border-border p-1.5 text-start transition-colors hover:border-orange hover:bg-orange-tint"
                    >
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-warning">
                        {t(issueKey(issue.kind))}
                        {issue.line_number != null &&
                          ` · ${t("words.onLine", { n: issue.line_number })}`}
                      </span>
                      <span className="text-[11px] leading-snug text-text-secondary">
                        {issue.detail}
                      </span>
                    </button>
                  ))}
                </div>
              </PanelCard>
            )}
          </>
        )}
      </Aside>

      {job?.log_url && (
        <RunLogDialog
          open={logOpen}
          onOpenChange={setLogOpen}
          mushafId={mushafId}
          runId={job.id}
          kind="words"
          live={running}
        />
      )}

      {job && (
        <ProcessCancelDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          job={job}
          onConfirm={() => {
            setCancelOpen(false);
            cancelWordDetection(mushafId).catch(() => toast.error(t("words.cancelFailed")));
          }}
        />
      )}

      <TourOverlay tour={tour} />
    </div>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** The page is only editable once detection AND review have settled it: the run
 * anchors on the aya ornaments whose positions Review is where you fix. */
function GateNotice({
  mushafId,
  page,
  processed,
}: {
  mushafId: string;
  page: number;
  processed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {processed ? t("words.gateUnreviewed", { page }) : t("words.gateUnprocessed", { page })}
        </p>
        <Link
          to={processed ? "/mushafs/$mushafId/review" : "/mushafs/$mushafId/process"}
          params={{ mushafId }}
          search={processed ? { page } : undefined}
          className="rounded-[7px] bg-orange px-3 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-orange-hover"
        >
          {processed ? t("words.gateToReview") : t("words.gateToProcess")}
        </Link>
      </div>
    </div>
  );
}

/** A word run counts lines, not pages — `pages_saved` stays zero for the whole
 * run, so reading it here would show a bar that never moves. */
function RunProgress({ job }: { job: ProcessJob }) {
  const { t } = useTranslation();
  const pct = job.total > 0 ? Math.round((job.lines_done / job.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
        <div className="h-full rounded-full bg-orange" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11.5px] text-text-muted">
        {t("words.progress", { done: job.lines_done, total: job.total })}
      </span>
    </div>
  );
}

function CutList({
  line,
  selectedCut,
  onSelectCut,
  onRemove,
  onToggleUnlabelled,
  onInsertWord,
  canMove,
  onMoveLine,
}: {
  line: EditLine;
  selectedCut: string | null;
  onSelectCut: (uid: string) => void;
  onRemove: (uid: string) => void;
  onToggleUnlabelled: (uid: string) => void;
  onInsertWord: (afterUid: string) => void;
  canMove: (cutUid: string, step: -1 | 1) => boolean;
  onMoveLine: (cutUid: string, step: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());

  // Follow the canvas: clicking a box there names a word here, and on a long line
  // that row is usually below the fold. Nothing moves when it is already visible,
  // so this is silent for a reviewer working down the list by hand.
  useEffect(() => {
    if (!selectedCut) return;
    revealInScroller(scroller.current, rows.current.get(selectedCut));
  }, [selectedCut]);

  return (
    <PanelCard title={t("words.cutsTitle", { line: line.line_number, count: line.cuts.length })}>
      {line.cuts.length === 0 ? (
        <p className="text-[12px] text-text-muted">{t("words.noCuts")}</p>
      ) : (
        // Tall enough for a whole line's words on a normal screen — at 18rem this
        // showed about nine of the fifteen a mushaf line carries, so the reviewer
        // was scrolling a list that had room to be whole. Capped against the
        // viewport as well, since the panel scrolls too and a card taller than the
        // window would push the run controls out of reach.
        <div ref={scroller} className="flex max-h-[min(55vh,34rem)] flex-col gap-1 overflow-y-auto">
          {line.cuts.map((cut, i) => (
            <div
              key={cut.uid}
              ref={(el) => {
                if (el) rows.current.set(cut.uid, el);
                else rows.current.delete(cut.uid);
              }}
              className={`flex flex-none items-center gap-2 rounded border p-1.5 transition-colors ${
                cut.uid === selectedCut ? "border-orange bg-orange-tint" : "border-border"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectCut(cut.uid)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start"
              >
                <span className="w-4 flex-none text-[10px] tabular-nums text-text-muted">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary" dir="rtl">
                  {cut.text || (cut.unlabelled ? t("words.unlabelled") : "—")}
                </span>
                <span className="flex-none text-[10px] tabular-nums text-text-muted">
                  {cut.aya}
                </span>
                <span
                  className="flex-none font-mono text-[10px] tabular-nums text-text-secondary"
                  title={t("words.boxSpan", { start: cut.start_x, end: cut.end_x })}
                >
                  {cut.start_x - cut.end_x}px
                </span>
              </button>
              {canMove(cut.uid, -1) && (
                <button
                  type="button"
                  title={t("words.moveUp")}
                  onClick={() => onMoveLine(cut.uid, -1)}
                  className="h-4 w-4 flex-none cursor-pointer rounded-sm border border-border-strong text-[10px] leading-none text-text-muted hover:border-orange hover:text-orange"
                >
                  ↑
                </button>
              )}
              {canMove(cut.uid, 1) && (
                <button
                  type="button"
                  title={t("words.moveDown")}
                  onClick={() => onMoveLine(cut.uid, 1)}
                  className="h-4 w-4 flex-none cursor-pointer rounded-sm border border-border-strong text-[10px] leading-none text-text-muted hover:border-orange hover:text-orange"
                >
                  ↓
                </button>
              )}
              <button
                type="button"
                title={t("words.toggleUnlabelled")}
                onClick={() => onToggleUnlabelled(cut.uid)}
                className={`h-4 w-4 flex-none cursor-pointer rounded-sm border text-[9px] font-bold leading-none ${
                  cut.unlabelled
                    ? "border-navy bg-navy text-white"
                    : "border-border-strong text-text-muted"
                }`}
              >
                ∅
              </button>
              <button
                type="button"
                title={t("words.insertAfter")}
                onClick={() => onInsertWord(cut.uid)}
                className="h-4 w-4 flex-none cursor-pointer rounded-sm border border-border-strong text-[11px] leading-none text-text-muted hover:border-navy hover:text-navy"
              >
                +
              </button>
              <button
                type="button"
                title={t("words.removeCut")}
                onClick={() => onRemove(cut.uid)}
                className="h-4 w-4 flex-none cursor-pointer rounded-sm border border-border-strong text-[10px] leading-none text-text-muted hover:border-error hover:text-error"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

const selectClass =
  "h-9 w-full cursor-pointer rounded-md border-[1.5px] border-border-strong bg-white px-2.5 text-[13px] text-text-primary outline-none focus:border-orange focus:shadow-[0_0_0_3px_var(--orange-glow)]";

const numberClass =
  "h-9 w-full rounded-md border-[1.5px] border-border-strong px-2.5 text-[13px] tabular-nums outline-none focus:border-orange";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.round(n) || lo));
}

/** `?page` off a blocker location. Read defensively because the blocker's
 * `search` is the union of every route's schema, and most of them have no page. */
function searchPage(location: { search: unknown }): number | null {
  const search = location.search as { page?: unknown } | undefined;
  return typeof search?.page === "number" ? search.page : null;
}

/** i18n key for a coherence issue. Returns literal types, not `string`, so `t()`
 * keeps its key checking — the same trick `runStatusKey` uses in details/helpers. */
function issueKey(kind: string) {
  switch (kind) {
    case "gap":
      return "words.issue_gap" as const;
    case "overlap":
      return "words.issue_overlap" as const;
    case "outside_aya":
      return "words.issue_outsideAya" as const;
    case "out_of_sequence":
      return "words.issue_outOfSequence" as const;
    case "unknown_word":
      return "words.issue_unknownWord" as const;
    default:
      return "words.issue_other" as const;
  }
}

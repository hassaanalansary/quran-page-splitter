import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CanvasHelp } from "@/components/app/CanvasHelp";
import { Aside, Hint, PanelCard, Section, StatusLine } from "@/components/app/Panel";
import { WordRunProgress } from "@/components/app/WordRunProgress";
import { WordsGateNotice } from "@/components/app/WordsGateNotice";
import { PageJump } from "@/components/canvas/PageJump";
import { PageRail } from "@/components/canvas/PageRail";
import { Button } from "@/components/ui/button";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { useZoomToPointer } from "@/hooks/use-zoom-to-pointer";
import {
  ApiError,
  calibrationKeys,
  cancelCalibration,
  confirmCalibration,
  explainType,
  isJobRunning,
  isJobSettled,
  previewCalibration,
  processCalibration,
  queryKeys,
  saveCalibration,
  suggestTypes,
  useCalibration,
  useCalibrationJob,
  useCalibrationPages,
  useProcessedPages,
} from "@/lib/api";
import {
  NO_SELECTION,
  acceptExpected,
  assignToWord,
  attentionItems,
  currentOf,
  doubtsOf,
  draftOf,
  editSignature,
  expectationsOf,
  extendSelection,
  highlights,
  historyOf,
  inkOf,
  newRequestId,
  pageExceptions,
  passesFilter,
  pushHistory,
  releaseDecisions,
  requestIds,
  resetWordEdges,
  setException,
  setRole,
  setSubtype,
  setWordEdges,
  shareBetween,
  stepAttention,
  stepBlob,
  stepHistory,
  stepLine,
  typeCounts,
  typeFilter,
  typeTally,
  typingSignature,
  wordCount,
  unassignMarks,
  type BlobFilter,
  type BlobSelection,
  type Doubts,
  type Expectations,
  type History,
} from "@/lib/calibration/model";
import type {
  CalibrationDocument,
  CalibrationDraft,
  CalibrationLine,
  TypeEvidence,
} from "@/lib/calibration/types";
import { revealInScroller } from "@/lib/reveal";
import { wordsPlace } from "@/lib/words/place";

import { BlobInspector } from "./BlobInspector";
import { BlobStrip } from "./BlobStrip";
import { HIGHLIGHT_RGB, ROLE_RGB } from "./colors";
import { ConfirmPageDialog } from "./ConfirmPageDialog";
import { EvaluationPanel } from "./EvaluationPanel";
import { LearningSettings } from "./LearningSettings";
import { WordPlayback } from "./WordPlayback";
import { exceptionKey, problemKey, subtypeKey } from "./labels";
import { SelectionBar } from "./SelectionBar";
import { HOTKEY_TYPES, SUBTYPE_MARKS, type Subtype } from "./subtypes";

const PAD = 20;
/** Screen px between stacked strips — constant, like the cuts editor's. */
const GAP = 18;
/** Zoom is fit-relative, as in the cuts editor: 1 is the text column filling the
 * canvas's width. */
const MIN_ZOOM = 0.25;
const FIT_ZOOM = 1;
const MAX_ZOOM = 8;
const STEP = 1.4;
/** Exceptions listed in the panel before the rest are left to the confirm dialog. */
const LISTED = 20;

/** Which server answer the editor holds. A save, a confirmation, a processing, or a
 * page gone stale each change it; a poll or a refocus bringing the same answer back
 * does not — and must not, or it would cost the reviewer their undo history. */
const docKey = (doc: CalibrationDocument) =>
  `${doc.page}:${doc.revision}:${doc.processed ? 1 : 0}:${doc.stale ? 1 : 0}`;

/** A preview on show: the re-read page, and the exact draft that produced it — the
 * one an acceptance sends back. */
type Preview = { doc: CalibrationDocument; draft: CalibrationDraft; signature: string };

/**
 * Calibration review of one page: every blob of ink on its lines, what it was read
 * as, and the decisions that correct it.
 *
 * **The loop.** Process the page (a background job) → look at what asks for a look,
 * correct roles and ownership, drag word edges → preview the page re-read under
 * those decisions, accept or discard → save the draft as often as you like →
 * confirm the page. Only a confirmation feeds calibration: a draft is never an
 * example, and neither is a preview.
 *
 * **Two modes, one picture.** Blobs mode selects ink (click, Shift-click, or drag a
 * rectangle) and labels it. Words mode drags word edges. Both paint every blob by
 * the role it currently has, and both show each word's PAW count against what its
 * spelling needs.
 *
 * **What is held here.** The page's editable lines, with an undo history of whole
 * states; the server's answer is only taken again when it is genuinely new, and
 * never over unsaved edits — see `docKey` and `held`.
 */
export function CalibrationEditor({
  mushafId,
  page,
  pageCount,
  onPageChange,
  modeSwitch,
  isRTL,
}: {
  mushafId: string;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** The step's Cuts | Calibrate switch, first in the panel. */
  modeSwitch: ReactNode;
  isRTL: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: pages } = useProcessedPages(mushafId);
  const ready = !!pages?.processed.has(page) && !!pages.reviewed.has(page);
  const { data: doc } = useCalibration(mushafId, page, ready);
  const { data: states } = useCalibrationPages(mushafId);
  const { data: job } = useCalibrationJob(mushafId);

  // ── what is being edited ───────────────────────────────────────────────────
  const [lines, setLines] = useState<CalibrationLine[]>([]);
  const [history, setHistory] = useState<History<CalibrationLine[]>>(() => historyOf([]));
  /** The edit signature of the lines as the server last stored them. */
  const [base, setBase] = useState("");
  /** The page the lines belong to; anything else on screen is a page still loading. */
  const [builtPage, setBuiltPage] = useState<number | null>(null);
  const [selection, setSelection] = useState<BlobSelection>(NO_SELECTION);
  /** The line the panel shows the words of. */
  const [focus, setFocus] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** A newer answer arrived over unsaved edits and was not taken. */
  const [held, setHeld] = useState(false);
  const [mode, setMode] = useState<"blobs" | "words">("blobs");
  const [selectionFilter, setSelectionFilter] = useState<BlobFilter>("all");
  /** Guessed types for the marks nobody has typed, and what they were learned from. */
  const [expectations, setExpectations] = useState<Expectations>(() => new Map());
  /** Typed marks the other pages' examples take for another type. */
  const [doubts, setDoubts] = useState<Doubts>(() => new Map());
  /** The typed examples nearest the one selected mark, for the selection bar: which
   * mark, asked against which typing, and the answer. */
  const [evidence, setEvidence] = useState<{
    key: string;
    mark: string;
    data: TypeEvidence | null;
    loading: boolean;
  } | null>(null);
  const [learnedFrom, setLearnedFrom] = useState({ examples: 0, here: 0 });
  const [showTypes, setShowTypes] = useState(true);
  const [dim, setDim] = useState(false);
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [box, setBox] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [requests] = useState(requestIds);

  const signature = useMemo(() => editSignature(lines), [lines]);
  const dirty = builtPage === page && signature !== base;

  // Latest values for handlers that outlive the render they were made in: a drag's
  // window listeners, and mutations whose answer lands renders later.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const docRef = useRef(doc);
  docRef.current = doc;
  const pageRef = useRef(page);
  pageRef.current = page;

  const builtRef = useRef<string | null>(null);
  /** Take the next answer even over unsaved edits: the reviewer asked to reload. */
  const forceRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const rebuild = useCallback((next: CalibrationDocument) => {
    builtRef.current = docKey(next);
    forceRef.current = false;
    setLines(next.lines);
    setHistory(historyOf(next.lines));
    setBase(editSignature(next.lines));
    setBuiltPage(next.page);
    setPreview(null);
    setHeld(false);
    setSelection(NO_SELECTION);
    setExpectations(new Map());
    setDoubts(new Map());
    // Keep the line being read when the new answer still has it.
    setFocus((previous) =>
      previous && next.lines.some((line) => line.snapshot_id === previous)
        ? previous
        : (next.lines[0]?.snapshot_id ?? null),
    );
  }, []);

  // Build whenever the server's answer differs from the one behind the lines —
  // unless there are unsaved edits on this page: then hold, and say so.
  useEffect(() => {
    if (!doc || doc.page !== page) return;
    if (builtRef.current === docKey(doc)) return;
    const samePage = builtRef.current?.startsWith(`${page}:`) ?? false;
    if (samePage && dirtyRef.current && !forceRef.current) {
      setHeld(true);
      return;
    }
    rebuild(doc);
  }, [doc, page, rebuild]);

  // ── derived ────────────────────────────────────────────────────────────────
  const running = isJobRunning(job);
  const processingHere = running && job?.current_page === page;
  const stale = !!doc?.stale;
  const contextStale = !stale && !!doc?.context_stale;
  const shownLines = preview ? preview.doc.lines : lines;
  const found = useMemo(() => pageExceptions(lines), [lines]);
  const looks = useMemo(() => attentionItems(shownLines).length, [shownLines]);

  const strips = useMemo(() => {
    if (builtPage !== page) return [];
    const context = (preview?.doc ?? doc)?.context ?? [];
    return [
      ...context.filter((line) => line.page_number < page),
      ...shownLines,
      ...context.filter((line) => line.page_number > page),
    ];
  }, [builtPage, page, preview, doc, shownLines]);

  // The page's text column: the union of every line's box, so the strips' right
  // edges — where Arabic starts — line up as they do on the page.
  const column = useMemo(() => {
    const drawn = strips.filter((line) => line.bbox.w > 0);
    if (!drawn.length) return null;
    const x = Math.min(...drawn.map((line) => line.bbox.x));
    const right = Math.max(...drawn.map((line) => line.bbox.x + line.bbox.w));
    return { x, w: Math.max(1, right - x) };
  }, [strips]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setBox(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = column && box ? Math.max(0.05, (box - 2 * PAD) / column.w) : 1;
  const scale = fit * zoom;
  useCtrlWheelZoom({ ref: scrollRef, zoom, onZoomChange: setZoom, min: MIN_ZOOM, max: MAX_ZOOM });
  useZoomToPointer({ scrollRef, imgRef: stageRef, scale });

  const selectedLine = shownLines.find((line) => line.snapshot_id === selection.snapshot) ?? null;
  const selectedBlobs = selectedLine
    ? selectedLine.blobs.filter((blob) => selection.ids.includes(blob.id))
    : [];
  const focusLine = shownLines.find((line) => line.snapshot_id === focus) ?? null;

  // ── editing ────────────────────────────────────────────────────────────────
  /** One edit, one undo step — and an edit that changed nothing, none. */
  const commit = (next: CalibrationLine[]) => {
    if (next === lines || editSignature(next) === signature) return;
    setLines(next);
    setHistory((current) => pushHistory(current, next));
  };
  const undo = () => {
    const next = stepHistory(history, -1);
    setHistory(next);
    setLines(currentOf(next));
  };
  const redo = () => {
    const next = stepHistory(history, 1);
    setHistory(next);
    setLines(currentOf(next));
  };

  const select = (next: BlobSelection) => {
    setSelection(next);
    if (next.snapshot) setFocus(next.snapshot);
  };

  /** Scroll a strip's element into view once it is on screen. */
  const reveal = (selector: string, axis: "both" | "vertical") => {
    requestAnimationFrame(() => {
      const target = stageRef.current?.querySelector<HTMLElement>(selector);
      revealInScroller(scrollRef.current, target, { margin: PAD, axis });
    });
  };

  const showLine = (snapshot: string) => {
    setFocus(snapshot);
    reveal(`[data-line="${CSS.escape(snapshot)}"]`, "vertical");
  };

  /** Select a blob reached from the keyboard, and bring it into view — its outline
   * is drawn by the render the selection causes, so the look waits a frame more. */
  const selectAndReveal = (next: BlobSelection) => {
    select(next);
    const last = next.ids[next.ids.length - 1];
    requestAnimationFrame(() =>
      reveal(`[data-blob-outline="${CSS.escape(`${next.snapshot}:${last}`)}"]`, "both"),
    );
  };

  /** The next blob asking for a look, in reading order, wrapping around. */
  const stepLook = (delta: 1 | -1) => {
    const next = stepAttention(shownLines, selection, delta);
    if (!next) {
      toast.info(t("calibration.nothingToLook"));
      return;
    }
    select(next);
    reveal(`[data-blob="${CSS.escape(`${next.snapshot}:${next.ids[0]}`)}"]`, "both");
  };

  // ── talking to the server ──────────────────────────────────────────────────
  // The processing job: only a run this screen watched is announced, since the
  // job endpoint answers with the latest run whether or not it is still going.
  const watchedRef = useRef<string | null>(null);
  const announcedRef = useRef<string | null>(null);
  /** The page the run is processing: a settled job no longer says. */
  const jobPageRef = useRef<number | null>(null);

  const reload = () => {
    forceRef.current = true;
    builtRef.current = null;
    setPreview(null);
    void queryClient.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
  };

  const failed = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) {
      // Stale revision, stale source, a reused request: every one of them is cured
      // by taking the page as the server has it now.
      toast.error(error.message, { action: { label: t("calibration.reload"), onClick: reload } });
    } else {
      toast.error(error instanceof ApiError ? error.message : t("calibration.requestFailed"));
    }
  };

  /** Send one request under an id kept until the server answers it, so a retry of
   * the same edits lands once — see `requestIds`. */
  const send = async <T,>(key: string, request: (id: string) => Promise<T>): Promise<T> => {
    try {
      const result = await request(requests.for(key));
      requests.answered(key);
      return result;
    } catch (error) {
      if (error instanceof ApiError) requests.answered(key);
      throw error;
    }
  };

  /** Record a stored answer as the one the lines were built from, without
   * rebuilding: it is these edits coming back, and edits made while it was on its
   * way must stay unsaved. */
  const adopt = (at: number, fresh: CalibrationDocument, sent: string) => {
    if (at === pageRef.current) {
      builtRef.current = docKey(fresh);
      setBase(sent);
    }
    queryClient.setQueryData(calibrationKeys.page(mushafId, at), fresh);
    void queryClient.invalidateQueries({ queryKey: calibrationKeys.pages(mushafId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const at = page;
      const current = docRef.current;
      if (!current) throw new Error("no document");
      const sent = linesRef.current;
      const sentSignature = editSignature(sent);
      const fresh = await send(`save:${at}:${current.revision}:${sentSignature}`, (id) =>
        saveCalibration(mushafId, at, draftOf(current, sent, id)),
      );
      return { at, fresh, sentSignature };
    },
    onSuccess: ({ at, fresh, sentSignature }) => {
      adopt(at, fresh, sentSignature);
      toast.success(t("calibration.savedToast"));
    },
    onError: failed,
  });

  const confirmMutation = useMutation({
    mutationFn: async (acknowledge: boolean) => {
      const at = page;
      const current = docRef.current;
      if (!current) throw new Error("no document");
      const sent = linesRef.current;
      const sentSignature = editSignature(sent);
      const fresh = await send(
        `confirm:${at}:${current.revision}:${acknowledge}:${sentSignature}`,
        (id) => confirmCalibration(mushafId, at, draftOf(current, sent, id, acknowledge)),
      );
      return { at, fresh, sentSignature };
    },
    onSuccess: ({ at, fresh, sentSignature }) => {
      adopt(at, fresh, sentSignature);
      setConfirmOpen(false);
      // The page's words are the product now, and one more page is evidence.
      void queryClient.invalidateQueries({ queryKey: queryKeys.pageWords(mushafId, at) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.wordsCoverage(mushafId) });
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.evaluation(mushafId) });
      toast.success(t("calibration.confirmedToast", { page: at }));
    },
    onError: failed,
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const at = page;
      const current = docRef.current;
      if (!current) throw new Error("no document");
      const sent = linesRef.current;
      // Stores nothing, so it needs no retry protection — only a well-formed id.
      const draft = draftOf(current, sent, newRequestId());
      const shown = await previewCalibration(mushafId, at, draft);
      return { at, shown, draft, signature: editSignature(sent) };
    },
    onSuccess: ({ at, shown, draft, signature: sent }) => {
      // Only the edits it was asked about; editing is off while it runs, but a
      // page change is not.
      if (at !== pageRef.current || sent !== editSignature(linesRef.current)) return;
      setPreview({ doc: shown, draft, signature: sent });
    },
    onError: failed,
  });

  /** Accepting stores the preview itself: the same draft, read again on the server
   * (`realign`), so the stored lines carry the preview's verdicts and flags — not
   * the edits with the old reading's verdicts beside them. Saving updates the
   * revision, but accepting remains one undoable edit. */
  const acceptMutation = useMutation({
    mutationFn: async () => {
      const at = page;
      const shown = preview;
      if (!shown) throw new Error("no preview");
      const fresh = await send(`accept:${at}:${shown.draft.revision}:${shown.signature}`, (id) =>
        saveCalibration(mushafId, at, { ...shown.draft, request_id: id, realign: true }),
      );
      return { at, fresh };
    },
    onSuccess: ({ at, fresh }) => {
      adopt(at, fresh, editSignature(fresh.lines));
      if (at === pageRef.current) {
        setLines(fresh.lines);
        setHistory((current) => pushHistory(current, fresh.lines));
        setPreview(null);
      }
      toast.success(t("calibration.acceptedToast"));
    },
    onError: failed,
  });

  const processMutation = useMutation({
    mutationFn: () => processCalibration(mushafId, page),
    onSuccess: ({ job: started }) => {
      jobPageRef.current = started.current_page ?? page;
      watchedRef.current = started.id;
      queryClient.setQueryData(calibrationKeys.job(mushafId), started);
    },
    onError: failed,
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelCalibration(mushafId),
    onSuccess: (updated) => queryClient.setQueryData(calibrationKeys.job(mushafId), updated),
    onError: failed,
  });

  // Announce a settled run once, and fetch what it stored.
  useEffect(() => {
    if (!job) return;
    if (isJobRunning(job)) {
      watchedRef.current = job.id;
      if (job.current_page) jobPageRef.current = job.current_page;
      return;
    }
    if (!isJobSettled(job) || watchedRef.current !== job.id || announcedRef.current === job.id) {
      return;
    }
    announcedRef.current = job.id;
    const at = jobPageRef.current ?? page;
    void queryClient.invalidateQueries({ queryKey: calibrationKeys.pages(mushafId) });
    void queryClient.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, at) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
    if (job.state === "completed") toast.success(t("calibration.processDone", { page: at }));
    else if (job.state === "cancelled") toast.info(t("calibration.processCancelled"));
    else toast.error(job.error ?? t("calibration.requestFailed"));
  }, [job, mushafId, page, queryClient, t]);

  const busy =
    saveMutation.isPending ||
    confirmMutation.isPending ||
    previewMutation.isPending ||
    acceptMutation.isPending;
  const processed = builtPage === page && !!doc?.processed;
  /** Edits are accepted: a processed, current page, with nothing else in flight. */
  const editable = processed && !stale && !held && !preview && !busy;

  // Ask for a type for every untyped mark when the page opens, and again shortly
  // after the typing changes — so the marks typed here teach the rest of the page
  // at once. Guesses change nothing in the draft: accepting one is what types it.
  const typing = useMemo(() => typingSignature(lines), [lines]);
  const canGuess = processed && !stale && !held;
  const revision = doc?.revision;
  useEffect(() => {
    const current = docRef.current;
    if (!canGuess || !current) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      suggestTypes(mushafId, page, draftOf(current, linesRef.current, newRequestId()), abort.signal)
        .then((answer) => {
          setExpectations(expectationsOf(answer.suggestions));
          setDoubts(doubtsOf(answer.doubts ?? []));
          setLearnedFrom({ examples: answer.examples, here: answer.typed_here });
        })
        // Hints only: a failure leaves the last guesses up, and saving says why.
        .catch(() => undefined);
    }, 500);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [canGuess, typing, revision, mushafId, page]);
  const types = useMemo(() => typeCounts(lines, expectations), [lines, expectations]);
  const tally = useMemo(
    () => typeTally(shownLines, expectations, doubts),
    [shownLines, expectations, doubts],
  );
  /** What the filter lets through: what a click, a drag and the arrow keys may pick. */
  const passes = (line: CalibrationLine, blob: CalibrationLine["blobs"][number]) =>
    passesFilter(blob, line.snapshot_id, selectionFilter, expectations, doubts);

  // The one selected mark's evidence: asked for shortly after it is selected, and
  // again when the typing it is judged against changes — the last answer for the
  // same mark stays up meanwhile, so typing it does not blank the bar.
  const explained =
    selectedBlobs.length === 1 && selectedBlobs[0].role === "mark" ? selectedBlobs[0] : null;
  const explainedMark = explained ? `${selection.snapshot}:${explained.id}` : "";
  const explainKey = explainedMark ? `${explainedMark}|${typing}` : "";
  useEffect(() => {
    const current = docRef.current;
    if (!explainKey || !canGuess || !current) return;
    const mark = explainKey.split("|")[0];
    const [snapshot, blob] = mark.split(":");
    const abort = new AbortController();
    setEvidence((previous) =>
      previous?.key === explainKey
        ? previous
        : {
            key: explainKey,
            mark,
            data: previous?.mark === mark ? previous.data : null,
            loading: true,
          },
    );
    const timer = window.setTimeout(() => {
      explainType(
        mushafId,
        page,
        draftOf(current, linesRef.current, newRequestId()),
        { snapshot_id: snapshot, blob_id: Number(blob) },
        abort.signal,
      )
        .then((data) => setEvidence({ key: explainKey, mark, data, loading: false }))
        .catch(() =>
          setEvidence((previous) =>
            previous?.key === explainKey ? { ...previous, loading: false } : previous,
          ),
        );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [explainKey, canGuess, mushafId, page]);

  // ── leaving ────────────────────────────────────────────────────────────────
  // Blocks a page change and a switch to the cuts editor too, not only leaving the
  // step: the lines are rebuilt per page, so either would drop them unasked.
  useBlocker({
    enableBeforeUnload: () => dirtyRef.current,
    shouldBlockFn: ({ current, next }) => {
      if (!dirtyRef.current) return false;
      if (current.pathname === next.pathname && wordsPlace(current) === wordsPlace(next)) {
        return false;
      }
      return !window.confirm(t("calibration.leaveConfirm"));
    },
  });

  // ── keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing || confirmOpen) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        if (key === "s") {
          event.preventDefault();
          if (editable && dirty) saveMutation.mutate();
        } else if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          if (editable) undo();
        } else if ((key === "z" && event.shiftKey) || key === "y") {
          event.preventDefault();
          if (editable) redo();
        }
        return;
      }
      if (event.altKey) return;
      if (key === "escape") {
        setSelection(NO_SELECTION);
      } else if (key === "n") {
        event.preventDefault();
        stepLook(event.shiftKey ? -1 : 1);
      } else if ((key === "b" || key === "m") && editable && selection.ids.length) {
        event.preventDefault();
        commit(setRole(lines, selection, key === "b" ? "body" : "mark"));
      } else if (key === "a" && editable && selection.ids.length) {
        event.preventDefault();
        commit(acceptExpected(lines, expectations, selection));
      } else if (/^[0-9]$/.test(key) && editable && selectedBlobs.some((b) => b.role === "mark")) {
        // 1 to 9, then 0: the types in HOTKEY_TYPES.
        event.preventDefault();
        commit(setSubtype(lines, selection, HOTKEY_TYPES[(Number(key) + 9) % 10]));
      } else if (
        (key === "arrowleft" || key === "arrowright" || key === "arrowup" || key === "arrowdown") &&
        processed &&
        mode === "blobs"
      ) {
        // The strips are the page as printed: left is onward, the way Arabic reads.
        event.preventDefault();
        const across = key === "arrowleft" || key === "arrowright";
        const delta = key === "arrowleft" || key === "arrowdown" ? 1 : -1;
        const next = !across
          ? stepLine(shownLines, selection, delta, passes)
          : event.shiftKey
            ? extendSelection(shownLines, selection, delta, passes)
            : stepBlob(shownLines, selection, delta, passes);
        if (next) selectAndReveal(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // No dependency array: the handler reads the current state, and every value it
    // closes over is rebuilt each render anyway.
  });

  // ── the page rail ──────────────────────────────────────────────────────────
  const { processedPages, confirmedPages } = useMemo(() => {
    const rows = states ?? [];
    return {
      processedPages: new Set(rows.filter((row) => row.processed).map((row) => row.page)),
      confirmedPages: new Set(
        rows.filter((row) => row.confirmed_revision !== null).map((row) => row.page),
      ),
    };
  }, [states]);

  // ── what the panel says ────────────────────────────────────────────────────
  const confirmedHead = doc?.confirmed_revision != null && doc.confirmed_revision === doc.revision;
  const status =
    processingHere && job ? (
      <WordRunProgress job={job} />
    ) : !pages ? (
      <StatusLine tone="info">{t("calibration.loadingPage")}</StatusLine>
    ) : !ready ? (
      <StatusLine tone="warning">{t("words.gateStatus", { page })}</StatusLine>
    ) : running ? (
      <StatusLine tone="info">
        {t("calibration.processOther", { page: job?.current_page ?? "…" })}
      </StatusLine>
    ) : builtPage !== page ? (
      <StatusLine tone="info">{t("calibration.loadingPage")}</StatusLine>
    ) : !processed ? (
      <StatusLine>{t("calibration.statusNotProcessed")}</StatusLine>
    ) : stale ? (
      <StatusLine tone="warning">{t("calibration.statusStale")}</StatusLine>
    ) : held ? (
      <StatusLine tone="warning">{t("calibration.statusHeld")}</StatusLine>
    ) : preview ? (
      <StatusLine tone="info">{t("calibration.statusPreview")}</StatusLine>
    ) : dirty ? (
      <StatusLine>{t("calibration.statusUnsaved")}</StatusLine>
    ) : contextStale ? (
      <StatusLine tone="warning">{t("calibration.statusContextStale")}</StatusLine>
    ) : looks ? (
      <StatusLine tone="action">{t("calibration.statusLook", { count: looks })}</StatusLine>
    ) : confirmedHead ? (
      <StatusLine tone="success">{t("calibration.statusConfirmed")}</StatusLine>
    ) : (
      <StatusLine tone="success">{t("calibration.statusClean")}</StatusLine>
    );

  const processButton = (
    <Button
      onClick={() => processMutation.mutate()}
      disabled={
        !ready || running || processMutation.isPending || dirty || busy || !!preview || held
      }
    >
      {processingHere || processMutation.isPending
        ? t("calibration.processing")
        : stale || contextStale
          ? t("calibration.processAgain", { page })
          : t("calibration.process", { page })}
    </Button>
  );

  const footer = preview ? (
    <div className="flex flex-col gap-2">
      <Button onClick={() => acceptMutation.mutate()} disabled={acceptMutation.isPending}>
        {acceptMutation.isPending ? t("common.saving") : t("calibration.acceptPreview")}
      </Button>
      <Button
        variant="outline"
        onClick={() => setPreview(null)}
        disabled={acceptMutation.isPending}
      >
        {t("calibration.discardPreview")}
      </Button>
    </div>
  ) : !processed || stale ? (
    processButton
  ) : (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        <Button
          variant="outline"
          className="flex-1"
          title={contextStale ? t("calibration.statusContextStale") : t("calibration.previewHelp")}
          onClick={() => previewMutation.mutate()}
          disabled={!editable || contextStale}
        >
          {previewMutation.isPending ? t("calibration.previewing") : t("calibration.preview")}
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => saveMutation.mutate()}
          disabled={!editable || !dirty}
        >
          {saveMutation.isPending ? t("common.saving") : t("calibration.saveDraft")}
        </Button>
      </div>
      <Button onClick={() => setConfirmOpen(true)} disabled={!editable}>
        {t("calibration.confirm")}
      </Button>
    </div>
  );

  const typeName = (subtype: string) => {
    const key = subtypeKey(subtype);
    return key ? t(key) : subtype;
  };
  const filterTypes = [...tally.types.entries()]
    .map(([subtype, count]) => ({ subtype, ...count }))
    .sort(
      (a, b) => b.typed + b.expected - (a.typed + a.expected) || a.subtype.localeCompare(b.subtype),
    );
  if (selectionFilter.startsWith("type:")) {
    const chosen = selectionFilter.slice("type:".length);
    if (!filterTypes.some((entry) => entry.subtype === chosen))
      filterTypes.push({ subtype: chosen, typed: 0, expected: 0 });
  }

  const problem = (kind: string) => {
    const key = problemKey(kind);
    return key ? t(key) : kind;
  };
  const exception = (value: string) => {
    const key = exceptionKey(value);
    return key ? t(key) : value;
  };

  // ── the canvas ─────────────────────────────────────────────────────────────
  const center = (content: ReactNode) => (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">{content}</div>
    </div>
  );

  const canvas =
    pages && !ready ? (
      <WordsGateNotice mushafId={mushafId} page={page} processed={!!pages.processed.has(page)} />
    ) : processingHere && job ? (
      center(
        <>
          <p className="text-[13px] text-text-secondary">
            {t("calibration.processStarted", { page })}
          </p>
          <div className="w-64">
            <WordRunProgress job={job} />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => cancelMutation.mutate()}
            disabled={job.cancel_requested || cancelMutation.isPending}
          >
            {t("calibration.stop")}
          </Button>
        </>,
      )
    ) : !doc || builtPage !== page ? (
      center(<p className="text-[12.5px] text-text-muted">{t("calibration.loadingPage")}</p>)
    ) : !processed ? (
      center(
        <>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            {t("calibration.processIntro")}
          </p>
          {processButton}
        </>,
      )
    ) : !column ? (
      center(<p className="text-[12.5px] text-text-muted">{t("calibration.noLines")}</p>)
    ) : (
      // dir=ltr: a picture of a page measured in pixels, and pixel x grows
      // rightwards whichever way the script reads.
      <div
        ref={stageRef}
        dir="ltr"
        className="relative flex w-max flex-col"
        style={{ minWidth: "100%", padding: PAD, gap: GAP }}
      >
        {strips.map((line) => (
          <div
            key={line.snapshot_id}
            onPointerDownCapture={() => {
              if (!line.readonly) setFocus(line.snapshot_id);
            }}
          >
            <BlobStrip
              line={line}
              scale={scale}
              marginLeft={(line.bbox.x - column.x) * scale}
              label={
                line.readonly
                  ? t("calibration.contextLabel", {
                      page: line.page_number,
                      n: line.line_number,
                    })
                  : t("calibration.lineLabel", { n: line.line_number })
              }
              focused={line.snapshot_id === focus}
              selection={selection}
              onSelect={select}
              mode={mode}
              selectionFilter={selectionFilter}
              expectations={expectations}
              doubts={doubts}
              showTypes={showTypes && mode === "blobs" && !line.readonly}
              dim={dim}
              selectable={!line.readonly}
              disabled={line.readonly || !editable}
              onWordEdge={(index, start, end) =>
                setLines((current) => setWordEdges(current, line.snapshot_id, index, start, end))
              }
              // Through the ref: the drag's listeners were attached when it began,
              // and a closure over `lines` would push the pre-drag state.
              onWordEdgeCommit={() =>
                setHistory((current) => pushHistory(current, linesRef.current))
              }
            />
          </div>
        ))}
      </div>
    );

  const step = (factor: number) =>
    setZoom((z) => Number(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)).toFixed(3)));

  const guideItems = [
    t("guide.calibration.s1"),
    t("guide.calibration.s2"),
    t("guide.calibration.s3"),
    t("guide.calibration.s4"),
    t("guide.calibration.s5"),
    t("guide.calibration.s6"),
    t("guide.calibration.s7"),
  ];

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden [&>aside]:max-h-[45%] [&>aside]:w-full [&>aside]:border-t lg:[&>aside]:max-h-none lg:[&>aside]:w-[340px] lg:[&>aside]:border-t-0 ${isRTL ? "lg:flex-row-reverse" : "lg:flex-row"}`}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-11 flex-shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-white px-3">
          <WordPlayback
            mushafId={mushafId}
            page={page}
            lines={shownLines}
            expectations={expectations}
            preview={!!preview}
            disabled={builtPage !== page || !!busy || stale}
            onInspect={(next) => {
              setMode("blobs");
              select(next);
              showLine(next.snapshot);
            }}
          />
          <div
            role="group"
            aria-label={t("calibration.modeLabel")}
            className="flex h-[26px] flex-none overflow-hidden rounded-sm border border-border-strong"
          >
            {(["blobs", "words"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                title={t(
                  value === "blobs" ? "calibration.modeBlobsHelp" : "calibration.modeWordsHelp",
                )}
                onClick={() => setMode(value)}
                className={`cursor-pointer px-2.5 text-[11.5px] font-medium transition-colors ${
                  mode === value
                    ? "bg-navy text-white"
                    : "bg-white text-text-secondary hover:bg-bg-surface"
                }`}
              >
                {t(value === "blobs" ? "calibration.modeBlobs" : "calibration.modeWords")}
              </button>
            ))}
          </div>

          <span className="mx-1 h-5 w-px flex-none bg-border" />
          {mode === "blobs" && (
            <span className="flex flex-none items-center gap-1.5">
              {highlights(selectionFilter) && (
                <span
                  className="h-2.5 w-2.5 flex-none rounded-sm"
                  style={{ background: `rgb(${HIGHLIGHT_RGB.join(",")})` }}
                  title={t("calibration.filter.shownHelp")}
                />
              )}
              <select
                aria-label={t("calibration.selectionFilter")}
                title={t("calibration.filter.help")}
                className="h-8 max-w-[220px] flex-none rounded-sm border border-border-strong bg-white px-2 text-[12px]"
                value={selectionFilter}
                onChange={(event) => {
                  setSelectionFilter(event.target.value as BlobFilter);
                  setSelection(NO_SELECTION);
                }}
              >
                <option value="all">{t("calibration.selectAllBlobs")}</option>
                <option value="mark">{t("calibration.selectMarks")}</option>
                <option value="body">{t("calibration.selectBodies")}</option>
                <optgroup label={t("calibration.filter.types")}>
                  {filterTypes.map(({ subtype, typed, expected }) => (
                    <option key={subtype} value={typeFilter(subtype)}>
                      {`${SUBTYPE_MARKS[subtype as Subtype] ?? "?"}  ${typeName(subtype)} · ${
                        expected
                          ? t("calibration.filter.count", { count: typed + expected, expected })
                          : typed + expected
                      }`}
                    </option>
                  ))}
                  <option value="untyped">
                    {t("calibration.filter.untyped", { count: tally.untyped })}
                  </option>
                  <option value="doubtful">
                    {t("calibration.filter.doubtful", { count: tally.doubtful })}
                  </option>
                </optgroup>
              </select>
            </span>
          )}
          <IconButton
            label={t("canvas.zoomOut")}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => step(1 / STEP)}
          >
            <Minus size={13} />
          </IconButton>
          <span className="w-11 flex-none text-center text-[11px] font-medium tabular-nums text-text-secondary">
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            label={t("canvas.zoomIn")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => step(STEP)}
          >
            <Plus size={13} />
          </IconButton>
          <IconButton
            label={t("canvas.fit")}
            disabled={zoom === FIT_ZOOM}
            onClick={() => setZoom(FIT_ZOOM)}
          >
            <Maximize2 size={12} />
          </IconButton>

          <span className="mx-1 h-5 w-px flex-none bg-border" />
          <IconButton
            label={t("words.undo")}
            disabled={!editable || history.index <= 0}
            onClick={undo}
          >
            <Undo2 size={13} />
          </IconButton>
          <IconButton
            label={t("words.redo")}
            disabled={!editable || history.index >= history.stack.length - 1}
            onClick={redo}
          >
            <Redo2 size={13} />
          </IconButton>

          <span className="mx-1 h-5 w-px flex-none bg-border" />
          <IconButton
            label={t("calibration.prevLook")}
            disabled={!looks}
            onClick={() => stepLook(-1)}
          >
            <ChevronLeft size={13} />
          </IconButton>
          <span className="flex-none whitespace-nowrap text-center text-[11px] tabular-nums text-text-secondary">
            {t("calibration.lookCount", { count: looks })}
          </span>
          <IconButton
            label={t("calibration.nextLook")}
            disabled={!looks}
            onClick={() => stepLook(1)}
          >
            <ChevronRight size={13} />
          </IconButton>
          <IconButton
            label={dim ? t("calibration.dimOff") : t("calibration.dimOn")}
            active={dim}
            onClick={() => setDim((value) => !value)}
          >
            {dim ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>

          <div className="ms-auto flex flex-none items-center gap-3">
            <div className="hidden items-center gap-2 xl:flex">
              {(["body", "mark", "ornament", "symbol"] as const).map((role) => (
                <span
                  key={role}
                  className="flex items-center gap-1 text-[10.5px] text-text-secondary"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: `rgb(${ROLE_RGB[role].join(",")})` }}
                  />
                  {t(`calibration.role.${role}`)}
                </span>
              ))}
            </div>
            <PageJump page={page} pageCount={pageCount} onPageChange={onPageChange} />
          </div>
        </div>

        {preview && (
          <div className="flex-shrink-0 border-b border-border bg-orange-tint px-3 py-1.5 text-[11.5px] leading-snug text-text-secondary">
            {t("calibration.previewBanner")}
          </div>
        )}

        <div ref={scrollRef} className="raqam-canvas-grid flex-1 overflow-auto">
          {canvas}
        </div>

        {processed && !stale && (
          <SelectionBar
            mushafId={mushafId}
            line={selectedLine}
            blobs={selectedBlobs}
            expectations={expectations}
            doubts={doubts}
            evidence={
              explained
                ? evidence?.mark === explainedMark
                  ? evidence
                  : { data: null, loading: true }
                : null
            }
            disabled={!editable}
            onRole={(role) => commit(setRole(lines, selection, role))}
            onSubtype={(value) => commit(setSubtype(lines, selection, value))}
            onAccept={() => commit(acceptExpected(lines, expectations, selection))}
          />
        )}

        <PageRail
          page={page}
          pageCount={pageCount}
          onPageChange={onPageChange}
          processed={processedPages}
          reviewed={confirmedPages}
          isRTL={isRTL}
        />

        <CanvasHelp guideItems={guideItems} coachText={t("coach.calibration")} />
      </div>

      <Aside status={status} footer={footer}>
        {modeSwitch}

        {processed && types.marks > 0 && (
          <PanelCard title={t("calibration.types.title")}>
            <p className="text-[11.5px] text-text-secondary">
              {t("calibration.types.summary", {
                typed: types.typed,
                marks: types.marks,
                expected: types.expected,
                sure: types.sure,
              })}
            </p>
            <p className="-mt-1 text-[10.5px] leading-snug text-text-muted">
              {learnedFrom.examples + learnedFrom.here
                ? t("calibration.types.learnedFrom", {
                    examples: learnedFrom.examples,
                    here: learnedFrom.here,
                  })
                : t("calibration.types.nothingYet")}
            </p>
            {tally.doubtful > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-sm bg-warning-bg px-2 py-1.5 text-[11.5px] leading-snug text-[#8a4b0d]">
                <span>{t("calibration.types.doubtful", { count: tally.doubtful })}</span>
                <Button
                  variant="outline"
                  className="h-7 flex-none px-2 text-[11.5px]"
                  onClick={() => {
                    setMode("blobs");
                    setSelectionFilter("doubtful");
                    setSelection(NO_SELECTION);
                  }}
                >
                  {t("calibration.types.showDoubtful")}
                </Button>
              </div>
            )}
            <Button
              variant="outline"
              className="h-8 text-[12px]"
              disabled={!editable || !types.sure}
              onClick={() => commit(acceptExpected(lines, expectations, "sure"))}
              title={t("calibration.types.acceptSureHelp")}
            >
              {t("calibration.types.acceptSure", { count: types.sure })}
            </Button>
            <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-text-secondary">
              <input
                type="checkbox"
                checked={showTypes}
                onChange={(event) => setShowTypes(event.target.checked)}
              />
              {t("calibration.types.show")}
            </label>
          </PanelCard>
        )}

        {stale && <Hint tone="warning">{t("calibration.staleHint")}</Hint>}
        {contextStale && (
          <Hint tone="warning">
            <div className="flex flex-col items-start gap-2">
              {t("calibration.contextStaleHint")}
              {processButton}
            </div>
          </Hint>
        )}
        {held && (
          <Hint tone="warning">
            <div className="flex flex-col items-start gap-2">
              {t("calibration.heldHint")}
              <Button variant="outline" size="sm" onClick={reload}>
                {t("calibration.reload")}
              </Button>
            </div>
          </Hint>
        )}

        {selectedLine && selectedBlobs.length > 0 && (
          <BlobInspector
            key={`${selection.snapshot}:${selection.ids.join(",")}`}
            mushafId={mushafId}
            page={page}
            line={selectedLine}
            blobs={selectedBlobs}
            disabled={!editable}
            onException={(value) => commit(setException(lines, selection, value))}
            onAssign={(wordId, paws) => commit(assignToWord(lines, selection, wordId, paws))}
            onShare={(shares) => commit(shareBetween(lines, selection, shares))}
            onRelease={() => commit(releaseDecisions(lines, selection))}
            onUnassign={() => commit(unassignMarks(lines, selection))}
          />
        )}

        {focusLine && (
          <WordList
            line={focusLine}
            selection={selection}
            editable={editable}
            onSelect={(ids) => select({ snapshot: focusLine.snapshot_id, ids })}
            onReset={(index) => commit(resetWordEdges(lines, focusLine.snapshot_id, index))}
          />
        )}

        {processed && found.length > 0 && (
          <PanelCard title={t("calibration.exceptionsTitle", { count: found.length })}>
            <p className="-mt-1 text-[10.5px] leading-snug text-text-muted">
              {t("calibration.exceptionsNote")}
            </p>
            <div className="flex flex-col gap-1">
              {found.slice(0, LISTED).map((item, index) => (
                <button
                  key={`${item.kind}-${item.line_number}-${index}`}
                  type="button"
                  onClick={() => {
                    const target = lines.find((line) => line.line_number === item.line_number);
                    if (target) showLine(target.snapshot_id);
                  }}
                  className="flex cursor-pointer flex-col gap-0.5 rounded border border-border p-1.5 text-start transition-colors hover:border-orange hover:bg-orange-tint"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-warning">
                    {problem(item.kind)} · {t("words.onLine", { n: item.line_number })}
                  </span>
                  {item.detail && (
                    <span dir="auto" className="text-[11px] leading-snug text-text-secondary">
                      {item.kind === "flagged" ? exception(item.detail) : item.detail}
                    </span>
                  )}
                </button>
              ))}
              {found.length > LISTED && (
                <span className="text-[10.5px] text-text-muted">
                  {t("calibration.moreExceptions", { count: found.length - LISTED })}
                </span>
              )}
            </div>
          </PanelCard>
        )}

        {processed && (doc?.issues.length ?? 0) > 0 && (
          <PanelCard title={t("calibration.issuesTitle")}>
            <div className="flex flex-wrap gap-1">
              {doc?.issues.map((issue) => (
                <span
                  key={issue}
                  className="rounded-sm bg-bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary"
                >
                  {issue}
                </span>
              ))}
            </div>
          </PanelCard>
        )}

        {doc?.settings && (
          <Section
            title={t("calibration.pageSection", { page })}
            defaultOpen={false}
            badge={
              doc.settings.experimental ? (
                <span className="rounded-sm bg-warning-bg px-1.5 py-px text-[10px] text-[#8a4b0d]">
                  {t("calibration.experimentalBadge")}
                </span>
              ) : undefined
            }
          >
            <LearningSettings
              mushafId={mushafId}
              page={page}
              settings={doc.settings}
              disabled={busy || running || !!preview || held}
            />
            {processed && (
              <PageCard
                page={page}
                revision={doc.revision}
                confirmedRevision={doc.confirmed_revision}
                profile={doc.profile}
              />
            )}
          </Section>
        )}

        <Section title={t("calibration.evaluationTitle")} defaultOpen={false}>
          <EvaluationPanel mushafId={mushafId} />
        </Section>
      </Aside>

      <ConfirmPageDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        page={page}
        exceptions={found}
        pending={confirmMutation.isPending}
        onConfirm={(acknowledge) => confirmMutation.mutate(acknowledge)}
      />
    </div>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** Where the page stands: its draft, its confirmation, and what it learns from. */
function PageCard({
  page,
  revision,
  confirmedRevision,
  profile,
}: {
  page: number;
  revision: number;
  confirmedRevision: number | null;
  profile: CalibrationDocument["profile"];
}) {
  const { t } = useTranslation();
  return (
    <PanelCard title={t("calibration.pageTitle", { page })}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-text-muted">{t("calibration.draft")}</dt>
        <dd className="tabular-nums">{t("calibration.revision", { revision })}</dd>
        <dt className="text-text-muted">{t("calibration.confirmation")}</dt>
        <dd>
          {confirmedRevision === null
            ? t("calibration.notConfirmed")
            : confirmedRevision === revision
              ? t("calibration.confirmedAt", { revision: confirmedRevision })
              : t("calibration.editedSinceConfirm", { revision: confirmedRevision })}
        </dd>
        <dt className="text-text-muted">{t("calibration.learning")}</dt>
        <dd>
          {profile.pages.length
            ? t("calibration.learningFrom", {
                count: profile.pages.length,
                examples: profile.examples,
              })
            : t("calibration.learningNone")}
        </dd>
      </dl>
      <p className="text-[10.5px] leading-snug text-text-muted">
        {t(
          profile.mode === "experimental"
            ? "calibration.experimentalNote"
            : "calibration.shadowNote",
        )}
      </p>
    </PanelCard>
  );
}

/** The focused line's words: each with its count, and — for one dragged by hand —
 * the way back to edges taken from its ink. A row selects that word's ink. */
function WordList({
  line,
  selection,
  editable,
  onSelect,
  onReset,
}: {
  line: CalibrationLine;
  selection: BlobSelection;
  editable: boolean;
  onSelect: (ids: number[]) => void;
  onReset: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <PanelCard
      title={t("calibration.wordsTitle", { line: line.line_number, count: line.words.length })}
    >
      {line.words.length === 0 ? (
        <p className="text-[12px] text-text-muted">{t("calibration.noWords")}</p>
      ) : (
        <div className="flex max-h-[min(45vh,28rem)] flex-col gap-1 overflow-y-auto">
          {line.words.map((word, index) => {
            const count = wordCount(line, word);
            const ink = inkOf(line, word.word_id);
            const active =
              ink.length > 0 &&
              selection.snapshot === line.snapshot_id &&
              selection.ids.length === ink.length &&
              ink.every((id) => selection.ids.includes(id));
            return (
              <div
                key={`${word.word_id ?? "u"}-${index}`}
                className={`flex flex-none items-center gap-2 rounded border p-1.5 transition-colors ${
                  active ? "border-orange bg-orange-tint" : "border-border"
                }`}
              >
                <button
                  type="button"
                  disabled={!ink.length}
                  title={t("calibration.selectWordInk")}
                  onClick={() => onSelect(ink)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start disabled:cursor-default"
                >
                  <span className="w-4 flex-none text-[10px] tabular-nums text-text-muted">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary" dir="rtl">
                    {word.text || t("calibration.unlabelledWord")}
                  </span>
                  <span className="flex-none text-[10px] tabular-nums text-text-muted">
                    {word.aya}
                  </span>
                  {word.shared && (
                    <span className="flex-none text-[10px] text-text-muted">
                      {t("calibration.shared")}
                    </span>
                  )}
                  <span
                    className={`flex-none rounded-sm px-1 text-[10px] font-semibold tabular-nums ${
                      count.ok ? "text-orange" : "bg-warning text-white"
                    }`}
                    title={t("calibration.countHelp")}
                  >
                    {word.word_id === null ? "∅" : `${count.got}/${count.want}`}
                  </span>
                </button>
                {word.override && (
                  <button
                    type="button"
                    title={t("calibration.resetEdges")}
                    disabled={!editable}
                    onClick={() => onReset(index)}
                    className="h-4 w-4 flex-none cursor-pointer rounded-sm border border-border-strong text-[10px] leading-none text-text-muted hover:border-orange hover:text-orange disabled:cursor-default disabled:opacity-40"
                  >
                    ↺
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PanelCard>
  );
}

function IconButton({
  label,
  disabled,
  active,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-sm border border-border-strong transition-colors disabled:cursor-default disabled:opacity-40 ${
        active
          ? "border-orange bg-orange text-white"
          : "bg-white text-text-secondary hover:bg-bg-surface"
      }`}
    >
      {children}
    </button>
  );
}

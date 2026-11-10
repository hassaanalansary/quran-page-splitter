import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Minus,
  Play,
  Plus,
  Redo2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CanvasHelp } from "@/components/app/CanvasHelp";
import { useLeaveGuard } from "@/components/app/LeaveGuard";
import { Aside, Hint, PanelCard, StatusLine, StepBody } from "@/components/app/Panel";
import { BusyLabel, LoadingState } from "@/components/app/SatrLoader";
import { WordRunProgress } from "@/components/app/WordRunProgress";
import { WordsGateNotice } from "@/components/app/WordsGateNotice";
import { PageJump } from "@/components/canvas/PageJump";
import { PageRail } from "@/components/canvas/PageRail";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { useZoomToPointer } from "@/hooks/use-zoom-to-pointer";
import {
  ApiError,
  calibrationKeys,
  cancelCalibration,
  compareWithLibrary,
  confirmCalibration,
  exportUrl,
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
  addSubtypePart,
  assignToWord,
  attentionItems,
  changedWords,
  currentOf,
  doubtsOf,
  draftOf,
  editSignature,
  expectationsOf,
  expectedType,
  extendSelection,
  galleryGroups,
  markChecksOf,
  markCheckOf,
  tanweenOf,
  highlights,
  historyOf,
  inkOf,
  newRequestId,
  noiseFor,
  noiseOf,
  pageExceptions,
  passesFilter,
  pushHistory,
  releaseDecisions,
  requestIds,
  setErased,
  setException,
  toggleFusedMark,
  setRole,
  setSubtype,
  shareBetween,
  stepAttention,
  stepBlob,
  stepGallery,
  stepHistory,
  stepLine,
  stepWord,
  teaches,
  typeCounts,
  typeFilter,
  typeTally,
  typingSignature,
  wordCount,
  unassignMarks,
  wordAt,
  type BlobFilter,
  type BlobSelection,
  type GalleryKind,
  type MarkChecks,
  type Doubts,
  type Expectations,
  type History,
  type NoiseSuspects,
} from "@/lib/calibration/model";
import type {
  CalibrationDocument,
  CalibrationDraft,
  CalibrationLine,
  LibraryCompare,
} from "@/lib/calibration/types";
import { revealInScroller } from "@/lib/reveal";
import { cn } from "@/lib/utils";

import { BlobStrip, STRIP_CHROME } from "./BlobStrip";
import { BulkPanel } from "./BulkPanel";
import { HIGHLIGHT_RGB, ROLE_RGB, UNSETTLED_RGB } from "./colors";
import { ConfirmPageDialog } from "./ConfirmPageDialog";
import { EvaluationPanel } from "./EvaluationPanel";
import { MarkGallery } from "./MarkGallery";
import { WordPlayer } from "./WordPlayback";
import { exceptionKey, problemKey, useTypeName } from "./labels";
import { LibraryView, type LibraryPlace } from "./LibraryView";
import { SelectionBar } from "./SelectionBar";
import { HOTKEY_TYPES, subtypeGlyph } from "./subtypes";

const PAD = 20;
/** Screen px between stacked strips — constant at every zoom. */
const GAP = 18;
/** Zoom is fit-relative: 1 is the text column filling the canvas's width. */
const MIN_ZOOM = 0.25;
const FIT_ZOOM = 1;
const MAX_ZOOM = 8;
const STEP = 1.4;
/** The zoom a blob opened from the Library is shown at. */
const SOURCE_ZOOM = 3;

type EditorMode = "blobs" | "gallery" | "library";
const MODE_LABEL = {
  blobs: "calibration.modeBlobs",
  gallery: "calibration.modeGallery",
  library: "calibration.modeLibrary",
} as const;
const MODE_HELP = {
  blobs: "calibration.modeBlobsHelp",
  gallery: "calibration.modeGalleryHelp",
  library: "calibration.modeLibraryHelp",
} as const;

/** How the Ink step was arrived at — see the route's search. */
export type InkEntry = { mode?: "library"; blob?: string; from?: number };

/** Where the Library was when a source was opened from it, for "Back to Library":
 * kept for the tab only, and read defensively — it may be gone or garbled. */
const placeKey = (mushafId: string) => `qps.library.place.${mushafId}`;
function writePlace(mushafId: string, place: LibraryPlace) {
  try {
    sessionStorage.setItem(placeKey(mushafId), JSON.stringify(place));
  } catch {
    // Storage blocked: coming back starts the Library at the top, which is harmless.
  }
}
function readPlace(mushafId: string): LibraryPlace | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(placeKey(mushafId)) ?? "null");
    return value && typeof value.scroll === "number" ? (value as LibraryPlace) : null;
  } catch {
    return null;
  }
}
/** Exceptions listed in the panel before the rest are left to the confirm dialog. */
const LISTED = 20;

/** Which server answer the editor holds. A save, a confirmation, a processing, or a
 * page gone stale each change it; a poll or a refocus bringing the same answer back
 * does not — and must not, or it would cost the reviewer their undo history. */
const docKey = (doc: CalibrationDocument) =>
  `${doc.page}:${doc.revision}:${doc.processed ? 1 : 0}:${doc.stale ? 1 : 0}`;

/** The page a location shows. Read defensively: a blocker's `search` is the union of
 * every route's schema, and most of them have no page. */
const pageOf = (location: { search: unknown }) =>
  (location.search as { page?: unknown } | undefined)?.page;

/** A preview on show: the re-read page, and the exact draft that produced it — the
 * one an acceptance sends back. */
type Preview = { doc: CalibrationDocument; draft: CalibrationDraft; signature: string };

/**
 * Calibration review of one page: every blob of ink on its lines, what it was read
 * as, and the decisions that correct it.
 *
 * **The loop.** Process the page (a background job) → look at what asks for a look,
 * correct roles and ownership → preview the page re-read under those decisions,
 * accept or discard → save the draft as often as you like → confirm the page. Only
 * a confirmation feeds calibration: a draft is never an example, and neither is a
 * preview. Every word's box is the extent of the ink given to it; no edge is placed
 * by hand.
 *
 * **Two modes.** Blobs mode selects ink (click, Shift-click, or drag a rectangle)
 * and labels it, painting every blob by the role it currently has and each word's
 * PAW count against what its spelling needs. The gallery lays the same ink out by
 * type or role.
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
  isRTL,
  entry = {},
  onOpenSource,
  onBackToLibrary,
}: {
  mushafId: string;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  isRTL: boolean;
  /** How the page was arrived at: in the Library, or at one blob opened from it (and
   * the page the Library was on, to go back to). */
  entry?: InkEntry;
  /** Open one blob's page with the blob selected — a fingerprint's source. */
  onOpenSource: (page: number, blob: string, from: number) => void;
  onBackToLibrary: (page: number) => void;
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
  const [mode, setMode] = useState<EditorMode>("blobs");
  /** The gallery groups marks by type, or all ink by role — at one zoom. */
  const [galleryKind, setGalleryKind] = useState<GalleryKind>("types");
  const [galleryZoom, setGalleryZoom] = useState(2);
  const [selectionFilter, setSelectionFilter] = useState<BlobFilter>("all");
  /** Guessed types for the marks nobody has typed, and what they were learned from. */
  const [expectations, setExpectations] = useState<Expectations>(() => new Map());
  /** Typed marks the other pages' examples — or their word's text — take for another type. */
  const [doubts, setDoubts] = useState<Doubts>(() => new Map());
  /** Every word's marks against its text's, and the strokes that make its tanweens. */
  const [checks, setChecks] = useState<MarkChecks>(() => new Map());
  const [tanween, setTanween] = useState<Set<string>>(() => new Set());
  /** Marks that may be noise the line's cutting left — for the reviewer to erase. */
  const [noise, setNoise] = useState<NoiseSuspects>(() => new Map());
  /** What the library answers for the one selected blob: which blob, asked against
   * which draft, and the answer. */
  const [comparison, setComparison] = useState<{
    key: string;
    blob: string;
    data: LibraryCompare | null;
    loading: boolean;
  } | null>(null);
  /** A LIMIT the Library is previewing: the library rebuilt at it, nothing saved. */
  const [previewLimit, setPreviewLimit] = useState<number | null>(null);
  const [learnedFrom, setLearnedFrom] = useState({ examples: 0, here: 0 });
  const [showTypes, setShowTypes] = useState(true);
  /** With a kind of mark shown, let a click pick the faded ink too — to fix a miss. */
  const [pickAll, setPickAll] = useState(false);
  const [dim, setDim] = useState(false);
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [box, setBox] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The page the words are being played on: playback ends with the page. */
  const [playback, setPlayback] = useState<number | null>(null);
  const [requests] = useState(requestIds);

  const signature = useMemo(() => editSignature(lines), [lines]);
  const dirty = builtPage === page && signature !== base;
  const playing = playback === page && builtPage === page;

  // Latest values for handlers that outlive the render they were made in: mutations
  // whose answer lands renders later.
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
    setNoise(new Map());
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
  /** The latest job when it is a batch of pages rather than one page. */
  const batch = job?.kind === "calibration_batch" ? job : null;
  const processingHere = running && !batch && job?.current_page === page;
  /** The running batch is on this page now: reached, and not yet processed or passed. */
  const batchHere =
    running &&
    !!batch &&
    batch.current_page === page &&
    !batch.report?.processed.includes(page) &&
    !Object.values(batch.report?.skipped ?? {}).some((pages) => pages?.includes(page));
  const stale = !!doc?.stale;
  const contextStale = !stale && !!doc?.context_stale;
  const shownLines = preview ? preview.doc.lines : lines;
  const found = useMemo(() => pageExceptions(lines), [lines]);
  const looks = useMemo(() => attentionItems(shownLines).length, [shownLines]);
  /** The marks that may be noise and are still ink, in reading order. */
  const suspects = useMemo(
    () =>
      lines
        .filter((line) => !line.readonly)
        .flatMap((line) =>
          [...line.blobs]
            .sort((a, b) => b.x + b.w - (a.x + a.w))
            .flatMap((blob) => {
              const found = noiseFor(blob, line.snapshot_id, noise);
              return found ? [{ line, blob, found }] : [];
            }),
        ),
    [lines, noise],
  );
  // Ayat the last reading (or the preview) left short of PAWs, and where each word is.
  const shortages = (preview ? preview.doc : doc)?.shortages ?? [];
  const wordOn = useMemo(
    () =>
      new Map(
        shownLines.flatMap((line) =>
          line.words.flatMap((word) =>
            word.word_id === null
              ? []
              : [[word.word_id, { text: word.text, snapshot: line.snapshot_id }] as const],
          ),
        ),
      ),
    [shownLines],
  );

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

  // Fit is the whole strip in view: its text column, the box around it and its number.
  const fit = column && box ? Math.max(0.05, (box - 2 * PAD - STRIP_CHROME) / column.w) : 1;
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
      // One more page is evidence.
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.evaluation(mushafId) });
      // The meter moves with every confirmation — that is what it is for.
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.readiness(mushafId) });
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
    void queryClient.invalidateQueries({ queryKey: calibrationKeys.pages(mushafId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
    if (job.kind === "calibration_batch") {
      // The page on screen may be one it processed; the meter's processing time moved.
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.readiness(mushafId) });
      const report = job.report;
      const processed = report?.processed.length ?? 0;
      const failed = report?.failed.length ?? 0;
      const skipped = Object.values(report?.skipped ?? {}).reduce(
        (total, pages) => total + (pages?.length ?? 0),
        0,
      );
      if (job.state === "completed")
        toast.success(t("calibration.bulk.doneToast", { processed, skipped, failed }));
      else if (job.state === "cancelled")
        toast.info(t("calibration.bulk.stoppedToast", { processed }));
      else toast.error(job.error ?? t("calibration.requestFailed"));
      return;
    }
    const at = jobPageRef.current ?? page;
    void queryClient.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, at) });
    if (job.state === "completed") toast.success(t("calibration.processDone", { page: at }));
    else if (job.state === "cancelled") toast.info(t("calibration.processCancelled"));
    else toast.error(job.error ?? t("calibration.requestFailed"));
  }, [job, mushafId, page, queryClient, t]);

  // A running batch: each page it finishes appears on the rail, and opens here if it
  // is the one on screen. The poll answers every second; only news is acted on.
  const batchDone = running ? (batch?.report?.processed.length ?? 0) : 0;
  const batchHasPage = running && !!batch?.report?.processed.includes(page);
  useEffect(() => {
    if (batchDone > 0)
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.pages(mushafId) });
  }, [batchDone, mushafId, queryClient]);
  useEffect(() => {
    if (batchHasPage)
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.page(mushafId, page) });
  }, [batchHasPage, mushafId, page, queryClient]);

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
          setChecks(markChecksOf(answer.words ?? []));
          setTanween(tanweenOf(answer.tanween ?? []));
          setNoise(noiseOf(answer.noise ?? []));
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

  // What the library answers for the one selected blob: asked for shortly after it is
  // selected, and again when the draft it is judged against changes — the last answer
  // for the same blob stays up meanwhile, so editing it does not blank the bar.
  const compared =
    canGuess &&
    selectedBlobs.length === 1 &&
    (selectedBlobs[0].role === "body" || selectedBlobs[0].role === "mark")
      ? selectedBlobs[0]
      : null;
  const comparedBlob = compared ? `${selection.snapshot}:${compared.id}` : "";
  const compareKey = comparedBlob ? `${comparedBlob}|${signature}|${previewLimit ?? ""}` : "";
  useEffect(() => {
    const current = docRef.current;
    if (!compareKey || !canGuess || !current) return;
    const blob = compareKey.split("|")[0];
    const [snapshot, id] = blob.split(":");
    const abort = new AbortController();
    setComparison((previous) =>
      previous?.key === compareKey
        ? previous
        : {
            key: compareKey,
            blob,
            data: previous?.blob === blob ? previous.data : null,
            loading: true,
          },
    );
    const timer = window.setTimeout(() => {
      compareWithLibrary(
        mushafId,
        page,
        draftOf(current, linesRef.current, newRequestId()),
        { snapshot_id: snapshot, blob_id: Number(id) },
        previewLimit,
        abort.signal,
      )
        .then((data) => setComparison({ key: compareKey, blob, data, loading: false }))
        .catch(() =>
          setComparison((previous) =>
            previous?.key === compareKey ? { ...previous, loading: false } : previous,
          ),
        );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
    // `previewLimit` is in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareKey, canGuess, mushafId, page]);
  const answer = compared
    ? comparison?.blob === comparedBlob
      ? comparison
      : { data: null, loading: true }
    : null;

  // Arriving: in the Library, or at a blob opened from it — selected, shown close.
  const arrived = useRef<string | null>(null);
  const [returnTo, setReturnTo] = useState<LibraryPlace | null>(null);
  useEffect(() => {
    if (builtPage !== page) return;
    const key = `${page}|${entry.mode ?? ""}|${entry.blob ?? ""}`;
    if (arrived.current === key) return;
    arrived.current = key;
    if (entry.mode === "library") {
      setMode("library");
      setReturnTo(readPlace(mushafId));
    }
    if (entry.blob) {
      const [snapshot, id] = entry.blob.split(":");
      const line = lines.find((candidate) => candidate.snapshot_id === snapshot);
      if (!line?.blobs.some((blob) => blob.id === Number(id))) {
        toast.info(t("calibration.library.sourceChanged"));
        return;
      }
      setMode("blobs");
      setZoom(SOURCE_ZOOM);
      requestAnimationFrame(() => selectAndReveal({ snapshot, ids: [Number(id)] }));
    }
    // Once per arrival; the lines are the page's own by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtPage, page, entry.mode, entry.blob]);

  // What a kind-of-mark filter shows on the page, and how many of those are only
  // expected — what "Accept the shown" would type.
  const shownByFilter = useMemo(() => {
    let count = 0;
    let expected = 0;
    if (!highlights(selectionFilter)) return { count, expected };
    for (const line of lines) {
      if (line.readonly) continue;
      for (const blob of line.blobs) {
        if (!passesFilter(blob, line.snapshot_id, selectionFilter, expectations, doubts)) continue;
        count += 1;
        if (expectedType(blob, line.snapshot_id, expectations)) expected += 1;
      }
    }
    return { count, expected };
  }, [lines, selectionFilter, expectations, doubts]);

  const gallery = useMemo(
    () =>
      mode === "gallery"
        ? galleryGroups(shownLines, galleryKind, selectionFilter, expectations, doubts)
        : [],
    [mode, shownLines, galleryKind, selectionFilter, expectations, doubts],
  );
  /** The words the preview's reading moved — what to look at before accepting it. */
  const moved = useMemo(
    () => (preview ? changedWords(lines, preview.doc.lines) : null),
    [preview, lines],
  );
  const lessons = useMemo(() => teaches(lines), [lines]);

  /** Show a blob picked in the gallery in its line, for what its crop cannot settle. */
  const openInLine = (next: BlobSelection) => {
    setMode("blobs");
    selectAndReveal(next);
  };

  /** Select a gallery cell reached from the keyboard, and bring it into view. */
  const selectCell = (next: BlobSelection) => {
    select(next);
    reveal(`[data-gallery="${CSS.escape(`${next.snapshot}:${next.ids[0]}`)}"]`, "vertical");
  };

  /** Select all of a word's ink, and bring its box into view. */
  const selectWord = (next: BlobSelection) => {
    select(next);
    const index = wordAt(shownLines, next);
    if (index !== null) reveal(`[data-word="${CSS.escape(`${next.snapshot}:${index}`)}"]`, "both");
  };

  // ── leaving ────────────────────────────────────────────────────────────────
  // Blocks a page change too, not only leaving the step: the lines are rebuilt per
  // page, so it would drop them unasked.
  const leaveDialog = useLeaveGuard({
    dirty: () => dirtyRef.current,
    leaves: (current, next) =>
      current.pathname !== next.pathname || pageOf(current) !== pageOf(next),
    body: t("calibration.leaveBody", { page }),
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
      // The player has keys of its own.
      if (typing || confirmOpen || playing) return;
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
        } else if ((key === "arrowleft" || key === "arrowright") && processed && mode === "blobs") {
          // Word by word; left is onward, as for blobs.
          event.preventDefault();
          const next = stepWord(shownLines, selection, key === "arrowleft" ? 1 : -1);
          if (next) selectWord(next);
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
      } else if (key === "delete" && editable && selection.ids.length) {
        // Erase the selection — or, when all of it is erased already, restore it.
        event.preventDefault();
        commit(setErased(lines, selection, !selectedBlobs.every((blob) => blob.erased)));
      } else if (key === "a" && editable && selection.ids.length) {
        event.preventDefault();
        commit(acceptExpected(lines, expectations, selection));
      } else if (
        event.shiftKey &&
        /^(Digit|Numpad)[0-9]$/.test(event.code) &&
        editable &&
        selectedBlobs.some((b) => b.role === "mark")
      ) {
        // Shift and a digit: add its type to the marks' own — two marks printed as one.
        event.preventDefault();
        const digit = Number(event.code.slice(-1));
        commit(addSubtypePart(lines, selection, HOTKEY_TYPES[(digit + 9) % 10], expectations));
      } else if (/^[0-9]$/.test(key) && editable && selectedBlobs.some((b) => b.role === "mark")) {
        // 1 to 9, then 0: the types in HOTKEY_TYPES.
        event.preventDefault();
        commit(setSubtype(lines, selection, HOTKEY_TYPES[(Number(key) + 9) % 10]));
      } else if (
        (key === "arrowleft" || key === "arrowright" || key === "arrowup" || key === "arrowdown") &&
        processed &&
        mode === "gallery"
      ) {
        // The gallery flows right to left, like the page: ← onward, ↑↓ by group.
        event.preventDefault();
        const delta = key === "arrowleft" || key === "arrowdown" ? 1 : -1;
        const next = stepGallery(
          gallery,
          selection,
          delta,
          key === "arrowup" || key === "arrowdown",
        );
        if (next) selectCell(next);
      } else if (key === "enter" && mode === "gallery" && selection.ids.length) {
        event.preventDefault();
        openInLine(selection);
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
    ) : running && batch ? (
      <StatusLine tone="info">
        {t("calibration.bulk.status", {
          page: batch.current_page ?? "…",
          done: batch.report?.processed.length ?? 0,
          total: batch.report?.planned ?? batch.total,
        })}
      </StatusLine>
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

  const processButton = (className?: string) => (
    <button
      type="button"
      className={cn(PRIMARY, className)}
      onClick={() => processMutation.mutate()}
      disabled={
        !ready || running || processMutation.isPending || dirty || busy || !!preview || held
      }
    >
      {processingHere || processMutation.isPending ? (
        <BusyLabel>{t("calibration.processing")}</BusyLabel>
      ) : stale || contextStale ? (
        t("calibration.processAgain", { page })
      ) : (
        t("calibration.process", { page })
      )}
    </button>
  );

  const footer = preview ? (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        className={PRIMARY}
        onClick={() => acceptMutation.mutate()}
        disabled={acceptMutation.isPending}
      >
        {acceptMutation.isPending ? (
          <BusyLabel>{t("common.saving")}</BusyLabel>
        ) : (
          t("calibration.acceptPreview")
        )}
      </button>
      <button
        type="button"
        className={OUTLINE}
        onClick={() => setPreview(null)}
        disabled={acceptMutation.isPending}
      >
        {t("calibration.discardPreview")}
      </button>
    </div>
  ) : !processed || stale ? (
    processButton()
  ) : (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          className={`${OUTLINE} flex-1`}
          title={contextStale ? t("calibration.statusContextStale") : t("calibration.previewHelp")}
          onClick={() => previewMutation.mutate()}
          disabled={!editable || contextStale}
        >
          {previewMutation.isPending ? (
            <BusyLabel>{t("calibration.previewing")}</BusyLabel>
          ) : (
            t("calibration.preview")
          )}
        </button>
        <button
          type="button"
          className={`${OUTLINE_INK} flex-1`}
          onClick={() => saveMutation.mutate()}
          disabled={!editable || !dirty}
        >
          {saveMutation.isPending ? (
            <BusyLabel>{t("common.saving")}</BusyLabel>
          ) : (
            t("calibration.saveDraft")
          )}
        </button>
      </div>
      <button
        type="button"
        className={PRIMARY}
        onClick={() => setConfirmOpen(true)}
        disabled={!editable}
      >
        {t("calibration.confirm")}
      </button>
    </div>
  );

  const typeName = useTypeName();
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

  const filterLabel = selectionFilter.startsWith("type:")
    ? `${subtypeGlyph(selectionFilter.slice("type:".length))} ${typeName(selectionFilter.slice("type:".length))}`
    : selectionFilter === "untyped"
      ? t("calibration.filter.untypedLabel")
      : t("calibration.filter.doubtfulLabel");

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
          <p className="text-[13px] text-ink-2">{t("calibration.processStarted", { page })}</p>
          <div className="w-64">
            <WordRunProgress job={job} />
          </div>
          <button
            type="button"
            className={`${OUTLINE} h-8 px-3`}
            onClick={() => cancelMutation.mutate()}
            disabled={job.cancel_requested || cancelMutation.isPending}
          >
            {t("calibration.stop")}
          </button>
        </>,
      )
    ) : !doc || builtPage !== page ? (
      center(
        <LoadingState className="text-[12.5px] text-ink-3">
          {t("calibration.loadingPage")}
        </LoadingState>,
      )
    ) : batchHere && !processed ? (
      center(<p className="text-[13px] text-ink-2">{t("calibration.bulk.here")}</p>)
    ) : !processed ? (
      center(
        <>
          <p className="text-[13px] leading-relaxed text-ink-2">{t("calibration.processIntro")}</p>
          {processButton()}
        </>,
      )
    ) : !column ? (
      center(<p className="text-[12.5px] text-ink-3">{t("calibration.noLines")}</p>)
    ) : mode === "library" ? (
      <LibraryView
        mushafId={mushafId}
        page={page}
        settings={doc.settings}
        selected={
          selectedLine && selectedBlobs.length === 1
            ? { line: selectedLine, blob: selectedBlobs[0] }
            : null
        }
        compare={answer}
        previewLimit={previewLimit}
        onPreviewLimit={setPreviewLimit}
        zoom={galleryZoom}
        onZoom={setGalleryZoom}
        scroller={scrollRef}
        restore={returnTo}
        onOpenSource={(shape, place) => {
          writePlace(mushafId, place);
          onOpenSource(shape.page_number, shape.key, page);
        }}
      />
    ) : mode === "gallery" ? (
      <MarkGallery
        groups={gallery}
        kind={galleryKind}
        onKind={(kind) => {
          setGalleryKind(kind);
          setSelection(NO_SELECTION);
        }}
        zoom={galleryZoom}
        onZoom={setGalleryZoom}
        expectations={expectations}
        doubts={doubts}
        selection={selection}
        editable={editable}
        onSelect={select}
        onOpen={openInLine}
        onAcceptGroup={(subtype) =>
          commit(
            acceptExpected(lines, expectations, (line, blob) =>
              passesFilter(blob, line.snapshot_id, typeFilter(subtype), expectations, doubts),
            ),
          )
        }
      />
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
              columnWidth={column.w * scale}
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
              selectionFilter={selectionFilter}
              pickAll={pickAll && highlights(selectionFilter)}
              movedWords={moved ?? undefined}
              expectations={expectations}
              doubts={doubts}
              tanween={tanween}
              noise={noise}
              checks={checks}
              showTypes={showTypes && mode === "blobs" && !line.readonly}
              dim={dim}
              selectable={!line.readonly}
              disabled={line.readonly || !editable}
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

  const pageLine =
    processed && doc ? (
      <span className="flex flex-wrap items-center gap-2">
        {t("calibration.pageTitle", { page })}
        <span className="rounded bg-sunk px-2 py-0.5 text-[12px] font-semibold text-ink-2">
          {t("calibration.draft")} · {t("calibration.revision", { revision: doc.revision })}
        </span>
        {doc.confirmed_revision === null
          ? t("calibration.pageNotConfirmed")
          : doc.confirmed_revision === doc.revision
            ? t("calibration.pageConfirmedAt", { revision: doc.confirmed_revision })
            : t("calibration.pageEditedSince", { revision: doc.confirmed_revision })}
      </span>
    ) : (
      t("calibration.pageTitle", { page })
    );
  const needsLook =
    processed &&
    (found.length > 0 ||
      shortages.length > 0 ||
      suspects.length > 0 ||
      (doc?.issues.length ?? 0) > 0);

  return (
    <StepBody>
      {/* Playing the words puts the editing away — hidden, not unmounted, so the
          canvas comes back as it was left — and takes the whole width. */}
      {playing && (
        <WordPlayer
          page={page}
          lines={shownLines}
          expectations={expectations}
          checks={checks}
          preview={!!preview}
          onExit={() => setPlayback(null)}
          onInspect={(next) => {
            setPlayback(null);
            setMode("blobs");
            selectWord(next);
          }}
        />
      )}
      <div
        className={`relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-well ${
          playing ? "hidden" : "flex"
        }`}
      >
        {/* Toolbar: the mode switch on deep, the filter, the things to look at,
            history, then playback and zoom on the far side. */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-sheet px-3.5 py-2.5">
          <div
            role="group"
            aria-label={t("calibration.modeLabel")}
            className="inline-flex flex-none rounded-lg bg-deep p-[3px]"
          >
            {(["blobs", "gallery", "library"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                title={t(MODE_HELP[value])}
                onClick={() => setMode(value)}
                className={`h-[30px] cursor-pointer rounded-[6px] px-[13px] text-[13px] transition-colors ${
                  mode === value
                    ? "bg-on-deep font-bold text-deep"
                    : "font-medium text-on-deep hover:bg-white/10"
                }`}
              >
                {t(MODE_LABEL[value])}
              </button>
            ))}
          </div>
          {entry.from !== undefined && (
            <button
              type="button"
              className={`${OUTLINE} h-[34px] flex-none gap-1.5 px-2.5 text-[12.5px]`}
              onClick={() => onBackToLibrary(entry.from!)}
            >
              <ChevronRight size={15} className="ltr:rotate-180" aria-hidden="true" />
              {t("calibration.library.back", { page: entry.from })}
            </button>
          )}
          <select
            hidden={mode === "library"}
            aria-label={t("calibration.selectionFilter")}
            title={t("calibration.filter.help")}
            className="h-[34px] max-w-[220px] flex-none cursor-pointer rounded-control border border-rule-2 bg-card px-2 text-[13px] text-ink outline-none focus:border-lapis"
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
                  {`${subtypeGlyph(subtype)}  ${typeName(subtype)} · ${
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

          <Divider />
          <span className="inline-flex flex-none items-center gap-0.5">
            <IconButton
              label={t("calibration.prevLook")}
              disabled={!looks}
              onClick={() => stepLook(-1)}
            >
              <ChevronLeft size={16} className="rtl:rotate-180" />
            </IconButton>
            <span
              className={`whitespace-nowrap rounded-pill px-[9px] py-[3px] text-[12.5px] font-semibold ${
                looks ? "bg-gold-wash text-gold-text" : "bg-sunk text-ink-3"
              }`}
            >
              {t("calibration.lookCount", { count: looks })}
            </span>
            <IconButton
              label={t("calibration.nextLook")}
              disabled={!looks}
              onClick={() => stepLook(1)}
            >
              <ChevronRight size={16} className="rtl:rotate-180" />
            </IconButton>
          </span>

          <Divider />
          <span className="inline-flex flex-none items-center gap-0.5">
            <IconButton
              label={t("words.undo")}
              disabled={!editable || history.index <= 0}
              onClick={undo}
            >
              <Undo2 size={16} />
            </IconButton>
            <IconButton
              label={t("words.redo")}
              disabled={!editable || history.index >= history.stack.length - 1}
              onClick={redo}
            >
              <Redo2 size={16} />
            </IconButton>
            <IconButton
              label={dim ? t("calibration.dimOff") : t("calibration.dimOn")}
              active={dim}
              onClick={() => setDim((value) => !value)}
            >
              {dim ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
          </span>

          <div className="ms-auto flex flex-none flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="inline-flex h-[30px] flex-none cursor-pointer items-center gap-1.5 rounded-control bg-gold px-2.5 text-[12.5px] font-semibold text-on-gold transition-[filter] hover:brightness-105 disabled:cursor-default disabled:opacity-50"
              disabled={
                builtPage !== page || !!busy || !shownLines.some((line) => line.words.length)
              }
              onClick={() => setPlayback(page)}
            >
              <Play size={13} aria-hidden="true" />
              {t("wordPlayback.open")}
            </button>
            {mode === "blobs" && (
              <span className="inline-flex items-center gap-0.5">
                <IconButton
                  label={t("canvas.zoomOut")}
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => step(1 / STEP)}
                >
                  <Minus size={15} />
                </IconButton>
                <span className="w-11 text-center font-mono text-[12px] text-ink-3">
                  {Math.round(zoom * 100)}%
                </span>
                <IconButton
                  label={t("canvas.zoomIn")}
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => step(STEP)}
                >
                  <Plus size={15} />
                </IconButton>
                <button
                  type="button"
                  disabled={zoom === FIT_ZOOM}
                  onClick={() => setZoom(FIT_ZOOM)}
                  className="h-[30px] cursor-pointer rounded-[6px] px-2 text-[13px] font-semibold text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:text-ink-4 disabled:hover:bg-transparent"
                >
                  {t("canvas.fit")}
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Stale: said on the canvas, where the editing stopped, with the way out. The
            draft can still be looked through and played; only editing waits. */}
        {processed && stale && (
          <div
            role="status"
            className="mx-[18px] mt-2.5 flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border-s-4 border-warn bg-warn-wash px-3.5 py-2.5"
          >
            <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
              <strong className="text-[13px] font-semibold text-warn-text">
                {t("calibration.statusStale")}
              </strong>
              <span className="text-[12.5px] leading-snug text-ink-2">
                {t("calibration.staleHint")}
              </span>
            </span>
            {processButton("h-9 flex-none px-3.5 text-[13px]")}
          </div>
        )}

        {/* Legend: the four ink roles, and how a word is drawn. */}
        {processed && mode === "blobs" && (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-[18px] pt-2.5 text-[12.5px] text-ink-2">
            {(["body", "mark", "ornament", "symbol"] as const).map((role) => (
              <span key={role} className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    background: `rgb(${ROLE_RGB[role].join(",")})`,
                    boxShadow: role === "body" ? "0 0 0 1px var(--rule-2)" : undefined,
                  }}
                />
                {t(`calibration.role.${role}`)}
              </span>
            ))}
            <span className="h-4 w-px bg-rule-2" aria-hidden="true" />
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3 w-[18px] rounded-[2px] border border-dashed"
                style={{ borderColor: "var(--ov-word)" }}
                aria-hidden="true"
              />
              {t("calibration.legendWord")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="font-mono text-[11px] font-semibold text-ink-3">2/2</span>
              {t("calibration.countHelp")}
            </span>
            <span className="h-4 w-px bg-rule-2" aria-hidden="true" />
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3 w-[18px] rounded-[2px] border-2"
                style={{ borderColor: "var(--ov-warn)", background: "rgba(154, 91, 0, 0.12)" }}
                aria-hidden="true"
              />
              {t("calibration.legendShort")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3 w-[18px] rounded-[2px] border-[1.5px] border-dashed"
                style={{ borderColor: "var(--ov-warn)" }}
                aria-hidden="true"
              />
              {t("calibration.legendUnfit")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="rounded-[3px] px-1 text-[9.5px] font-bold leading-[13px] text-white"
                style={{ background: "var(--ov-warn)" }}
                aria-hidden="true"
              >
                ⚑
              </span>
              {t("calibration.legendFlagged")}
            </span>
            {showTypes && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-3 w-3 rounded-full border-2"
                  style={{
                    borderColor: `rgb(${UNSETTLED_RGB.join(",")})`,
                    background: `rgb(${UNSETTLED_RGB.join(",")} / 0.35)`,
                  }}
                  aria-hidden="true"
                />
                {t("calibration.legendUnsettled")}
              </span>
            )}
          </div>
        )}

        {processed && highlights(selectionFilter) && (
          <div
            className="mx-[18px] mt-2.5 flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-1.5 text-[12px] text-ink-2"
            style={{ background: `rgb(${HIGHLIGHT_RGB.join(",")} / 0.08)` }}
          >
            <span className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 flex-none rounded-sm"
                style={{ background: `rgb(${HIGHLIGHT_RGB.join(",")})` }}
              />
              {t("calibration.filter.showing", {
                what: filterLabel,
                count: shownByFilter.count,
                expected: shownByFilter.expected,
              })}
            </span>
            {mode === "blobs" && (
              <label
                className="flex cursor-pointer items-center gap-1.5"
                title={t("calibration.filter.pickAllHelp")}
              >
                <input
                  type="checkbox"
                  checked={pickAll}
                  onChange={(event) => setPickAll(event.target.checked)}
                  className="accent-lapis"
                />
                {t("calibration.filter.pickAll")}
              </label>
            )}
            {shownByFilter.expected > 0 && (
              <button
                type="button"
                className={`${OUTLINE} h-7 px-2.5 text-[12px]`}
                disabled={!editable}
                onClick={() => commit(acceptExpected(lines, expectations, passes))}
                title={t("calibration.filter.acceptShownHelp")}
              >
                {t("calibration.filter.acceptShown", { count: shownByFilter.expected })}
              </button>
            )}
          </div>
        )}

        {preview && (
          <div className="mx-[18px] mt-2.5 flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-lapis-wash px-3 py-1.5 text-[12px] leading-snug text-ink-2">
            <span>{t("calibration.previewBanner")}</span>
            <span className="flex items-center gap-1.5 font-medium text-ink">
              <span
                className="h-2.5 w-2.5 flex-none rounded-sm border-2"
                style={{ borderColor: "var(--ov-line-selected)" }}
              />
              {t("calibration.previewMoved", { count: moved?.size ?? 0 })}
            </span>
            {!!moved?.size && (
              <span className="flex items-center gap-1">
                <IconButton
                  label={t("calibration.previewMovedPrevious")}
                  onClick={() => {
                    const next = stepWord(
                      shownLines,
                      selection,
                      -1,
                      (_, word) => word.word_id !== null && moved.has(word.word_id),
                    );
                    if (next) selectWord(next);
                  }}
                >
                  <ChevronRight size={15} />
                </IconButton>
                <IconButton
                  label={t("calibration.previewMovedNext")}
                  onClick={() => {
                    const next = stepWord(
                      shownLines,
                      selection,
                      1,
                      (_, word) => word.word_id !== null && moved.has(word.word_id),
                    );
                    if (next) selectWord(next);
                  }}
                >
                  <ChevronLeft size={15} />
                </IconButton>
              </span>
            )}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-auto">
          {canvas}
        </div>

        {processed && mode !== "library" && (
          <SelectionBar
            line={selectedLine}
            blobs={selectedBlobs}
            expectations={expectations}
            doubts={doubts}
            checks={checks}
            noise={noise}
            library={answer}
            onShowInLibrary={() => setMode("library")}
            disabled={!editable}
            onRole={(role) => commit(setRole(lines, selection, role))}
            onSubtype={(value) => commit(setSubtype(lines, selection, value))}
            onAddPart={(part) => commit(addSubtypePart(lines, selection, part, expectations))}
            onAccept={() => commit(acceptExpected(lines, expectations, selection))}
            onException={(value) => commit(setException(lines, selection, value))}
            onFusedMark={(part) => commit(toggleFusedMark(lines, selection, part))}
            onErase={(erased) => commit(setErased(lines, selection, erased))}
            onAssign={(wordId, paws) => commit(assignToWord(lines, selection, wordId, paws))}
            onShare={(shares) => commit(shareBetween(lines, selection, shares))}
            onRelease={() => commit(releaseDecisions(lines, selection))}
            onUnassign={() => commit(unassignMarks(lines, selection))}
          />
        )}

        <PageRail
          page={page}
          pageCount={pageCount}
          onPageChange={onPageChange}
          processed={processedPages}
          reviewed={confirmedPages}
          isRTL={isRTL}
          end={
            <>
              <span className="hidden items-center gap-3 text-[12px] text-ink-3 md:inline-flex">
                <span className="inline-flex items-center gap-[5px]">
                  <span className="h-[9px] w-[9px] rounded-[2px] bg-done" aria-hidden="true" />
                  {t("calibration.railConfirmed")}
                </span>
                <span className="inline-flex items-center gap-[5px]">
                  <span className="h-[9px] w-[9px] rounded-[2px] bg-lapis" aria-hidden="true" />
                  {t("calibration.railDraft")}
                </span>
              </span>
              <span className="rounded-control border border-rule-2 bg-card px-2.5 py-1">
                <PageJump page={page} pageCount={pageCount} onPageChange={onPageChange} />
              </span>
            </>
          }
        />

        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.calibration")}
          className="top-[112px]"
        />
      </div>

      <div className={playing ? "hidden" : "contents"}>
        <Aside intro={pageLine} status={status} footer={footer}>
          {contextStale && (
            <Hint tone="warning">
              <div className="flex flex-col items-stretch gap-2">
                {t("calibration.contextStaleHint")}
                {processButton()}
              </div>
            </Hint>
          )}
          {held && (
            <Hint tone="warning">
              <div className="flex flex-col items-start gap-2">
                {t("calibration.heldHint")}
                <button type="button" className={`${OUTLINE} h-8 px-3`} onClick={reload}>
                  {t("calibration.reload")}
                </button>
              </div>
            </Hint>
          )}

          {needsLook && (
            <section className="flex flex-col gap-2.5 rounded-card border border-rule bg-card p-3.5">
              <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                {t("calibration.needsLook")}
              </h2>
              {found.length > 0 && (
                <LookGroup title={t("calibration.look.acknowledge")} count={found.length}>
                  {found.slice(0, LISTED).map((item, index) => (
                    <LookRow
                      key={`${item.kind}-${item.line_number}-${index}`}
                      tag={t("calibration.lineKey", { n: item.line_number })}
                      title={t("calibration.exceptionsNote")}
                      onClick={() => {
                        // The blob or the word itself, selected and shown; else its line.
                        const target = lines.find((line) => line.snapshot_id === item.snapshot);
                        if (target && item.blob_id !== undefined) {
                          setMode("blobs");
                          selectAndReveal({ snapshot: target.snapshot_id, ids: [item.blob_id] });
                        } else if (target && item.word_id !== undefined) {
                          const ink = target.blobs
                            .filter((blob) =>
                              blob.allocations.some((a) => a.word_id === item.word_id),
                            )
                            .map((blob) => blob.id);
                          setMode("blobs");
                          if (ink.length) selectWord({ snapshot: target.snapshot_id, ids: ink });
                          else showLine(target.snapshot_id);
                        } else {
                          const line = lines.find((row) => row.line_number === item.line_number);
                          if (line) showLine(line.snapshot_id);
                        }
                      }}
                    >
                      {problem(item.kind)}
                      {item.detail &&
                        ` · ${item.kind === "flagged" ? exception(item.detail) : item.detail}`}
                    </LookRow>
                  ))}
                  {found.length > LISTED && (
                    <span className="text-[12px] text-ink-3">
                      {t("calibration.moreExceptions", { count: found.length - LISTED })}
                    </span>
                  )}
                </LookGroup>
              )}
              {shortages.length > 0 && (
                <LookGroup title={t("calibration.look.shortages")} count={shortages.length}>
                  {shortages.map((item) => {
                    const short = item.words
                      .map((id) => wordOn.get(id))
                      .filter((word) => word !== undefined);
                    return (
                      <LookRow
                        key={item.aya}
                        tag={t("calibration.ayaKey", { aya: item.aya })}
                        title={t("calibration.shortagesNote")}
                        word={item.certain ? short[0]?.text : undefined}
                        disabled={!short.length}
                        onClick={() => short[0] && showLine(short[0].snapshot)}
                      >
                        {t("calibration.shortCount", { count: item.short })}
                        {" · "}
                        {item.certain && short.length
                          ? t("calibration.shortageLikely", {
                              words: short.map((word) => word.text).join("، "),
                            })
                          : t("calibration.shortageUncertain")}
                      </LookRow>
                    );
                  })}
                </LookGroup>
              )}
              {suspects.length > 0 && (
                <LookGroup title={t("calibration.look.noise")} count={suspects.length}>
                  {suspects.map(({ line, blob, found: item }) => (
                    <LookRow
                      key={`${line.snapshot_id}:${blob.id}`}
                      tag={t("calibration.lineKey", { n: line.line_number })}
                      title={t("calibration.noise.note")}
                      onClick={() => {
                        setMode("blobs");
                        selectAndReveal({ snapshot: line.snapshot_id, ids: [blob.id] });
                      }}
                    >
                      {t(`calibration.noise.${item.kind}`)} ·{" "}
                      {t("calibration.noise.detail", { w: blob.w, h: blob.h, area: blob.area })}
                      {item.edge ? ` · ${t("calibration.noise.edge")}` : ""}
                    </LookRow>
                  ))}
                </LookGroup>
              )}
              {suspects.length > 0 && (
                <button
                  type="button"
                  className={`${OUTLINE} h-[34px] text-[12.5px]`}
                  disabled={!editable}
                  onClick={() =>
                    commit(
                      suspects.reduce(
                        (current, { line, blob }) =>
                          setErased(current, { snapshot: line.snapshot_id, ids: [blob.id] }, true),
                        lines,
                      ),
                    )
                  }
                  title={t("calibration.noise.eraseAllHelp")}
                >
                  {t("calibration.noise.eraseAll", { count: suspects.length })}
                </button>
              )}
              {(doc?.issues.length ?? 0) > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-semibold">{t("calibration.issuesTitle")}</span>
                  <div className="flex flex-wrap gap-1">
                    {doc?.issues.map((issue) => (
                      <span
                        key={issue}
                        className="rounded bg-sheet px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2"
                      >
                        {issue}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {focusLine && (
            <WordList
              line={focusLine}
              current={
                selection.snapshot === focusLine.snapshot_id ? wordAt(shownLines, selection) : null
              }
              onSelect={(ids) => selectWord({ snapshot: focusLine.snapshot_id, ids })}
              onStep={(delta) => {
                const next = stepWord(shownLines, selection, delta);
                if (next) selectWord(next);
              }}
              checks={checks}
            />
          )}

          {processed && types.marks > 0 && (
            <section className="flex flex-col gap-2.5 rounded-card border border-rule bg-card p-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                  {t("calibration.types.title")}
                </h2>
                <span className="font-mono text-[12px] text-ink-3">
                  {t("calibration.types.typedOf", { typed: types.typed, marks: types.marks })}
                </span>
              </div>
              {filterTypes.length > 0 && (
                <div className="flex flex-wrap gap-[5px]">
                  {filterTypes.map(({ subtype, typed, expected }) => (
                    <span
                      key={subtype}
                      title={typeName(subtype)}
                      className="inline-flex items-center gap-[5px] rounded-pill border border-rule bg-sheet py-[3px] pe-2 ps-1.5"
                    >
                      <span
                        dir="rtl"
                        className="font-quran text-[15px] leading-none text-mark-text"
                      >
                        {subtypeGlyph(subtype)}
                      </span>
                      <span className="font-mono text-[11.5px] text-ink-3">{typed + expected}</span>
                    </span>
                  ))}
                </div>
              )}
              <p className="m-0 text-[12.5px] leading-normal text-ink-3">
                {t("calibration.types.summary", {
                  typed: types.typed,
                  marks: types.marks,
                  expected: types.expected,
                  sure: types.sure,
                })}
                {" · "}
                {learnedFrom.examples + learnedFrom.here
                  ? t("calibration.types.learnedFrom", {
                      examples: learnedFrom.examples,
                      here: learnedFrom.here,
                    })
                  : t("calibration.types.nothingYet")}
              </p>
              <button
                type="button"
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-control border border-lapis bg-lapis-wash text-[13px] font-semibold text-lapis-text transition-colors hover:bg-lapis hover:text-on-lapis disabled:cursor-default disabled:opacity-50 disabled:hover:bg-lapis-wash disabled:hover:text-lapis-text"
                disabled={!editable || !types.sure}
                onClick={() => commit(acceptExpected(lines, expectations, "sure"))}
                title={t("calibration.types.acceptSureHelp")}
              >
                {t("calibration.types.acceptSure", { count: types.sure })}
              </button>
              {tally.doubtful > 0 && (
                <span className="flex items-center justify-between gap-2.5 rounded-control bg-warn-wash px-2.5 py-2 text-[12.5px] leading-snug text-warn-text">
                  <span>{t("calibration.types.doubtful", { count: tally.doubtful })}</span>
                  <button
                    type="button"
                    className="flex-none cursor-pointer font-semibold hover:underline"
                    onClick={() => {
                      setMode("blobs");
                      setSelectionFilter("doubtful");
                      setSelection(NO_SELECTION);
                    }}
                  >
                    {t("calibration.types.showDoubtful")}
                  </button>
                </span>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
                <input
                  type="checkbox"
                  checked={showTypes}
                  onChange={(event) => setShowTypes(event.target.checked)}
                  className="h-4 w-4 accent-lapis"
                />
                {t("calibration.types.show")}
              </label>
            </section>
          )}

          <BulkPanel
            mushafId={mushafId}
            page={page}
            pageCount={pageCount}
            job={job ?? null}
            onStarted={(started) => {
              watchedRef.current = started.id;
              queryClient.setQueryData(calibrationKeys.job(mushafId), started);
            }}
            onStop={() => cancelMutation.mutate()}
            stopping={cancelMutation.isPending}
          />

          <div className="flex flex-col overflow-hidden rounded-card border border-rule bg-card">
            {doc?.settings && (
              <Fold title={t("calibration.pageSection", { page })}>
                {processed && (
                  <PageCard
                    mushafId={mushafId}
                    page={page}
                    revision={doc.revision}
                    confirmedRevision={doc.confirmed_revision}
                    profile={doc.profile}
                  />
                )}
              </Fold>
            )}
            <Fold title={t("calibration.evaluationTitle")}>
              <EvaluationPanel mushafId={mushafId} />
            </Fold>
          </div>
        </Aside>
      </div>

      <ConfirmPageDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        page={page}
        exceptions={found}
        teaches={lessons}
        pending={confirmMutation.isPending}
        onConfirm={(acknowledge) => confirmMutation.mutate(acknowledge)}
      />
      {leaveDialog}
    </StepBody>
  );
}

/** The step's buttons: primary lapis, outlined, outlined in ink. */
const PRIMARY =
  "inline-flex h-11 cursor-pointer items-center justify-center rounded-control bg-lapis px-4 text-[14px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50";
const OUTLINE =
  "inline-flex h-10 cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card text-[13px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-50";
const OUTLINE_INK =
  "inline-flex h-10 cursor-pointer items-center justify-center rounded-control border border-ink bg-transparent text-[13px] font-semibold text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:opacity-50";

// ── pieces ───────────────────────────────────────────────────────────────────

/** Where the page stands: its draft, its confirmation, and what it learns from — and
 * its data, as the full export carries it. */
function PageCard({
  mushafId,
  page,
  revision,
  confirmedRevision,
  profile,
}: {
  mushafId: string;
  page: number;
  revision: number;
  confirmedRevision: number | null;
  profile: CalibrationDocument["profile"];
}) {
  const { t } = useTranslation();
  return (
    <PanelCard title={t("calibration.pageTitle", { page })}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-ink-3">{t("calibration.draft")}</dt>
        <dd className="tabular-nums">{t("calibration.revision", { revision })}</dd>
        <dt className="text-ink-3">{t("calibration.confirmation")}</dt>
        <dd>
          {confirmedRevision === null
            ? t("calibration.notConfirmed")
            : confirmedRevision === revision
              ? t("calibration.confirmedAt", { revision: confirmedRevision })
              : t("calibration.editedSinceConfirm", { revision: confirmedRevision })}
        </dd>
        <dt className="text-ink-3">{t("calibration.learning")}</dt>
        <dd>
          {profile.pages.length
            ? t("calibration.learningFrom", {
                count: profile.pages.length,
                examples: profile.examples,
                fingerprints: profile.fingerprints ?? "—",
              })
            : t("calibration.learningNone")}
        </dd>
      </dl>
      <p className="text-[10.5px] leading-snug text-ink-3">
        {t(profile.mode === "shadow" ? "calibration.shadowNote" : "calibration.learnedNote")}
      </p>
      <a
        href={exportUrl(mushafId, { page })}
        download
        className="text-[11.5px] font-semibold text-lapis-text hover:text-lapis-text/80"
      >
        {t("calibration.downloadPage")}
      </a>
    </PanelCard>
  );
}

/** The focused line's words, each with its count. A row selects that word's ink and
 * shows it; the arrows step word by word across the page, as Ctrl+← → do. */
function WordList({
  line,
  current,
  onSelect,
  onStep,
  checks,
}: {
  line: CalibrationLine;
  /** The word the selection is in, on this line. */
  current: number | null;
  onSelect: (ids: number[]) => void;
  onStep: (delta: 1 | -1) => void;
  /** Every word's marks against its text's. */
  checks: MarkChecks;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  // Keep the current word's row in view as the words are walked.
  useEffect(() => {
    if (current === null) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-word-row="${current}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current, line.snapshot_id]);
  return (
    <section className="flex flex-col gap-2 rounded-card border border-rule bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {t("calibration.wordsOnLine", { line: line.line_number })}
        </h2>
        <span className="flex items-center gap-0.5">
          <span className="me-1 font-mono text-[12px] text-ink-3">
            {current !== null
              ? t("calibration.wordNav.of", { index: current + 1, count: line.words.length })
              : line.words.length}
          </span>
          <IconButton label={t("calibration.wordNav.previous")} onClick={() => onStep(-1)}>
            <ChevronUp size={15} />
          </IconButton>
          <IconButton label={t("calibration.wordNav.next")} onClick={() => onStep(1)}>
            <ChevronDown size={15} />
          </IconButton>
        </span>
      </div>
      {current === null && line.words.length > 0 && (
        <span className="text-[12px] text-ink-3">{t("calibration.wordNav.keys")}</span>
      )}
      {line.words.length === 0 ? (
        <p className="m-0 text-[12.5px] text-ink-3">{t("calibration.noWords")}</p>
      ) : (
        <div ref={list} className="flex max-h-[min(45vh,28rem)] flex-col gap-[3px] overflow-y-auto">
          {line.words.map((word, index) => {
            const count = wordCount(line, word);
            const ink = inkOf(line, word.word_id);
            const active = index === current;
            const check = markCheckOf(line.snapshot_id, word.word_id, checks);
            return (
              <button
                key={`${word.word_id ?? "u"}-${index}`}
                type="button"
                data-word-row={index}
                disabled={!ink.length}
                title={t("calibration.selectWordInk")}
                onClick={() => onSelect(ink)}
                className={`flex flex-none cursor-pointer items-center gap-2.5 rounded-control px-2 py-[3px] text-start transition-colors disabled:cursor-default ${
                  active
                    ? "bg-lapis-wash shadow-[inset_0_0_0_1.5px_var(--lapis)]"
                    : "hover:bg-sheet"
                }`}
              >
                <span className="w-4 flex-none font-mono text-[11px] text-ink-4">{index + 1}</span>
                <span
                  lang="ar"
                  dir="rtl"
                  className="min-w-0 flex-1 truncate font-quran text-[18px] leading-relaxed text-ink"
                >
                  {word.text || t("calibration.unlabelledWord")}
                </span>
                {word.shared && (
                  <span className="flex-none text-[11px] text-ink-3">
                    {t("calibration.shared")}
                  </span>
                )}
                <span dir="ltr" className="flex-none font-mono text-[11px] text-ink-4">
                  {word.aya}
                </span>
                <span
                  className={`min-w-[30px] flex-none rounded px-1 text-center font-mono text-[11px] font-semibold ${
                    count.ok ? "text-ink-3" : "bg-warn text-on-warn"
                  }`}
                  title={t("calibration.countHelp")}
                >
                  {word.word_id === null ? "∅" : `${count.got}/${count.want}`}
                </span>
                <span
                  className={`w-3.5 flex-none text-[12px] font-bold ${
                    check?.ok ? "text-done-text" : "text-warn-text"
                  }`}
                  title={
                    check
                      ? t(
                          check.ok
                            ? "calibration.marksCheck.okHelp"
                            : "calibration.marksCheck.offHelp",
                          {
                            missing: check.missing.length,
                            extra: check.extra.length + check.disagree.length,
                          },
                        )
                      : undefined
                  }
                >
                  {check ? (check.ok ? "✓" : "≠") : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One of the things that ask for a look: its name and how many, then its rows. */
function LookGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="font-mono text-[12px] text-warn-text">{count}</span>
      </span>
      {children}
    </div>
  );
}

/** A row that opens its line: where it is, what it is, and the word when known. */
function LookRow({
  tag,
  title,
  word,
  disabled,
  onClick,
  children,
}: {
  tag: string;
  title: string;
  word?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-[34px] cursor-pointer items-center gap-2.5 rounded-control bg-warn-wash px-2.5 py-1 text-start transition-[filter] hover:brightness-[0.97] disabled:cursor-default"
    >
      <span className="flex-none font-mono text-[11.5px] font-semibold text-warn-text">{tag}</span>
      <span dir="auto" className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">
        {children}
      </span>
      {word && (
        <span lang="ar" dir="rtl" className="flex-none font-quran text-[17px] leading-normal">
          {word}
        </span>
      )}
    </button>
  );
}

/** A folded section of the inspector's last card: a row to open it, then what it holds. */
function Fold({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-rule-soft first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-[42px] w-full cursor-pointer items-center gap-2 px-3.5 text-start text-[13px] font-semibold text-ink transition-colors hover:bg-sheet"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`flex-none text-ink-4 transition-transform ${open ? "rotate-90" : "rtl:rotate-180"}`}
        />
        <span className="min-w-0 flex-1">{title}</span>
        {badge}
      </button>
      {open && <div className="flex flex-col gap-3 px-3.5 pb-3.5">{children}</div>}
    </div>
  );
}

function Divider() {
  return <span className="h-[22px] w-px flex-none bg-rule" aria-hidden="true" />;
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
      className={`flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-[6px] transition-colors disabled:cursor-default disabled:opacity-30 ${
        active ? "bg-ink text-paper" : "text-ink hover:bg-sunk"
      }`}
    >
      {children}
    </button>
  );
}

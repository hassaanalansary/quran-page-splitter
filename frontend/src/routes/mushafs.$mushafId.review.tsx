import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Plus, Trash, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Field, Hint, StatusLine } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { ReviewEditCanvas } from "@/components/canvas/ReviewEditCanvas";
import { RectInputs } from "@/components/canvas/RectInputs";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  bulkSavePages,
  getReviewData,
  pageImageUrl,
  queryKeys,
  useMushaf,
  useSuras,
  type BulkSaveInput,
  type Rect,
  type ReviewData,
  type Sura,
} from "@/lib/api";
import {
  editPageFromApiPage,
  fromApi,
  genId,
  type EditLine,
  type EditLineType,
  type EditPage,
  type ReviewStore,
} from "@/lib/review/model";
import {
  pageSignature,
  recompute,
  suraSpanPages,
  toApiPage,
  type DerivedLine,
} from "@/lib/review/recompute";

export const Route = createFileRoute("/mushafs/$mushafId/review")({
  validateSearch: (s: Record<string, unknown>) => ({ page: Math.max(1, Number(s.page) || 1) }),
  component: ReviewPage,
});

const HISTORY_LIMIT = 100;
const COALESCE_MS = 500;

const LINE_TYPE_VALUES: EditLineType[] = ["text", "sura_header", "besmella"];

/** Per-type accent, matching the line-box colours on the canvas so the panel
 * reads as the same object (orange = text, navy = sura header, green = besmella). */
const TYPE_COLOR: Record<EditLineType, string> = {
  text: "var(--orange)",
  sura_header: "var(--navy)",
  besmella: "var(--success)",
};

function ReviewPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/review" });
  const { page } = Route.useSearch();
  const navigate = useNavigate({ from: "/mushafs/$mushafId/review" });
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const { data: mushaf } = useMushaf(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  // Own key (NOT under the mushaf prefix) so mushaf invalidations don't refetch
  // it, and no window-focus refetch — the store is authoritative for the session.
  const { data: reviewData } = useQuery({
    queryKey: ["review-data", mushafId],
    queryFn: ({ signal }) => getReviewData(mushafId, signal),
    refetchOnWindowFocus: false,
  });

  // ── editing store + undo/redo history ──────────────────────────────────────
  // history + index as ONE state so updates are atomic (see applyStore).
  const [hist, setHist] = useState<{ stack: ReviewStore[]; index: number }>({
    stack: [],
    index: -1,
  });
  const store = hist.stack[hist.index] ?? null;
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  // The selected separator (a cut within a text line), independent of the line
  // selection so its parent line's editor stays open while it's highlighted.
  const [selectedCut, setSelectedCut] = useState<{ uid: string; index: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Bumped when the saved baseline changes without the store changing (post-save).
  const [baselineVersion, setBaselineVersion] = useState(0);

  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  const baselineRef = useRef<Map<number, string>>(new Map());
  const baselineReviewedRef = useRef<Set<number>>(new Set());
  const builtForRef = useRef<string | null>(null);
  // Page whose first line we've already auto-selected, so entering a page selects
  // line 1 once (the navigator's "current line") without fighting later deselects.
  const selInitRef = useRef<number | null>(null);

  // Build the store for ALL logical pages exactly ONCE per mushaf. Later
  // refetches (focus, invalidations) must NOT rebuild — that would wipe local
  // edits. A different mushaf id (or a remount) triggers a fresh build.
  useEffect(() => {
    if (!reviewData || !mushaf) return;
    if (builtForRef.current === mushafId) return;
    builtForRef.current = mushafId;
    const next = fromApi(reviewData, mushaf.logical_page_count);
    baselineRef.current = new Map(next.pages.map((p) => [p.page_number, pageSignature(p)]));
    baselineReviewedRef.current = new Set(
      next.pages.filter((p) => p.reviewed).map((p) => p.page_number),
    );
    coalesceRef.current = null;
    setHist({ stack: [next], index: 0 });
    setSelectedUid(null);
    setSelectedCut(null);
    selInitRef.current = null;
    setBaselineVersion((v) => v + 1);
  }, [reviewData, mushaf, mushafId]);

  // Push a store snapshot via a FUNCTIONAL update over the combined {stack,index}.
  // Rapid drag edits fire many events before React re-renders; a closure-based
  // update would read a stale index and corrupt the pointer (blanking the page
  // → "Loading…"). The functional updater always sees the latest state.
  const applyStore = useCallback((next: ReviewStore, key?: string) => {
    const now = Date.now();
    const prev = coalesceRef.current;
    const replace = !!key && !!prev && prev.key === key && now - prev.at < COALESCE_MS;
    coalesceRef.current = key ? { key, at: now } : null;
    setHist((h) => {
      if (replace && h.index >= 0) {
        const stack = h.stack.slice();
        stack[h.index] = next;
        return { stack, index: h.index };
      }
      const appended = [...h.stack.slice(0, h.index + 1), next];
      const stack = appended.length > HISTORY_LIMIT ? appended.slice(-HISTORY_LIMIT) : appended;
      return { stack, index: stack.length - 1 };
    });
  }, []);

  const canUndo = hist.index > 0;
  const canRedo = hist.index >= 0 && hist.index < hist.stack.length - 1;
  const undo = useCallback(() => {
    coalesceRef.current = null;
    setHist((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  }, []);
  const redo = useCallback(() => {
    coalesceRef.current = null;
    setHist((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (canUndo) undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        if (canRedo) redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, canUndo, canRedo]);

  // ── derived numbering (mirrors the server) ─────────────────────────────────
  const derived = useMemo(() => (store ? recompute(store, suras) : null), [store, suras]);
  const currentEdit = store?.pages.find((p) => p.page_number === page) ?? null;
  const currentDerived = derived?.pages.find((p) => p.page_number === page) ?? null;
  const selectedEdit = currentEdit?.lines.find((l) => l.uid === selectedUid) ?? null;
  const selectedDerived = currentDerived?.lines.find((l) => l.uid === selectedUid) ?? null;
  const suraName = (n: number) =>
    suras?.find((s) => s.number === n)?.transliteration ?? t("review.suraFallback", { n });

  // Selection helpers: a line and a separator are selected independently, but
  // picking one clears the incompatible parts (a line-select drops any cut; a
  // cut-select pins its parent line so the editor stays open).
  const selectLine = useCallback((uid: string | null) => {
    setSelectedUid(uid);
    setSelectedCut(null);
  }, []);
  const selectCut = useCallback((uid: string, index: number) => {
    setSelectedUid(uid);
    setSelectedCut({ uid, index });
  }, []);

  // Landing on a page selects its first line — the navigator's starting "current
  // line" — once per page, so later manual deselection isn't undone.
  useEffect(() => {
    if (!currentEdit) return;
    if (selInitRef.current === page) return;
    selInitRef.current = page;
    setSelectedUid(currentEdit.lines[0]?.uid ?? null);
    setSelectedCut(null);
  }, [currentEdit, page]);

  // Content-dirty pages (structure changed vs the last-saved baseline).
  const dirtyPages = useMemo(() => {
    if (!store) return [] as number[];
    return store.pages
      .filter((p) => pageSignature(p) !== baselineRef.current.get(p.page_number))
      .map((p) => p.page_number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, baselineVersion]);

  // Pages marked reviewed in the client but not yet persisted.
  const reviewedPending = useMemo(() => {
    if (!store) return [] as number[];
    return store.pages
      .filter((p) => p.reviewed && !baselineReviewedRef.current.has(p.page_number))
      .map((p) => p.page_number);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, baselineVersion]);

  const unsavedCount = dirtyPages.length + reviewedPending.length;

  // Rail indicators derive from the live store (all pages are present).
  const railProcessed = useMemo(
    () => new Set((store?.pages ?? []).filter((p) => p.lines.length > 0).map((p) => p.page_number)),
    [store],
  );
  const railReviewed = useMemo(
    () => new Set((store?.pages ?? []).filter((p) => p.reviewed).map((p) => p.page_number)),
    [store],
  );

  const logicalCount = mushaf?.logical_page_count ?? 1;

  function goto(n: number) {
    navigate({ search: { page: Math.max(1, Math.min(logicalCount, n)) } });
  }

  // ── leave guard (free within the route; confirm on real navigation) ─────────
  useBlocker({
    enableBeforeUnload: () => unsavedCount > 0,
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (unsavedCount === 0) return false;
      return !window.confirm(t("review.leaveConfirm"));
    },
  });

  // ── mutation helpers (keyed by line uid; every edit lands in history) ───────
  const mutatePage = useCallback(
    (fn: (p: EditPage) => EditPage, key?: string) => {
      if (!store) return;
      applyStore(
        { ...store, pages: store.pages.map((p) => (p.page_number === page ? fn(p) : p)) },
        key,
      );
    },
    [store, page, applyStore],
  );

  const updateLine = useCallback(
    (uid: string, patch: Partial<EditLine>, key?: string) => {
      mutatePage(
        (p) => ({ ...p, lines: p.lines.map((l) => (l.uid === uid ? { ...l, ...patch } : l)) }),
        key,
      );
    },
    [mutatePage],
  );

  const updateLineBbox = (uid: string, bbox: Rect) => updateLine(uid, { bbox }, `bbox:${uid}`);
  // Double-click adds a cut and selects it, so its delete button is right there.
  const addCut = (uid: string, x: number) => {
    const line = currentEdit?.lines.find((l) => l.uid === uid);
    if (!line) return;
    const index = line.cuts.length;
    updateLine(uid, { cuts: [...line.cuts, Math.round(x)] });
    selectCut(uid, index);
  };
  const moveCut = (uid: string, i: number, x: number) => {
    const line = currentEdit?.lines.find((l) => l.uid === uid);
    if (!line) return;
    const cuts = line.cuts.slice();
    cuts[i] = Math.round(x);
    updateLine(uid, { cuts }, `sep:${uid}:${i}`);
  };
  const removeCut = (uid: string, i: number) => {
    const line = currentEdit?.lines.find((l) => l.uid === uid);
    if (line) updateLine(uid, { cuts: line.cuts.filter((_, idx) => idx !== i) });
    // Indices shift after a removal — drop the selection rather than mis-point it.
    setSelectedCut(null);
  };

  const setLineType = (uid: string, type: EditLineType) => {
    updateLine(uid, {
      type,
      cuts: type === "text" ? (currentEdit?.lines.find((l) => l.uid === uid)?.cuts ?? []) : [],
      sura:
        type === "sura_header" ? currentEdit?.lines.find((l) => l.uid === uid)?.sura : undefined,
    });
    // A non-text line has no separators; clear any selection pointing at one.
    if (type !== "text" && selectedCut?.uid === uid) setSelectedCut(null);
  };

  // Anchor the running sura at a header (propagates forward until the next anchor).
  const setSura = (uid: string, sura: number) => updateLine(uid, { sura });

  const deleteLine = (uid: string) => {
    mutatePage((p) => ({ ...p, lines: p.lines.filter((l) => l.uid !== uid) }));
    if (selectedUid === uid) setSelectedUid(null);
    if (selectedCut?.uid === uid) setSelectedCut(null);
  };

  const addLineAfter = (uid: string | null, type: EditLineType) => {
    const newUid = genId("line");
    // A sensible default box for a fresh line (esp. on a blank/manual page).
    const fresh: Rect = natural
      ? {
          x: Math.round(natural.w * 0.08),
          y: Math.round(natural.h * 0.08),
          w: Math.round(natural.w * 0.84),
          h: Math.max(40, Math.round(natural.h * 0.05)),
        }
      : { x: 20, y: 20, w: 600, h: 60 };
    mutatePage((p) => {
      const idx = uid ? p.lines.findIndex((l) => l.uid === uid) : p.lines.length - 1;
      const ref = idx >= 0 ? p.lines[idx] : null;
      const bbox: Rect = ref
        ? { x: ref.bbox.x, y: ref.bbox.y + ref.bbox.h + 10, w: ref.bbox.w, h: ref.bbox.h }
        : fresh;
      const lines = p.lines.slice();
      lines.splice(idx + 1, 0, { uid: newUid, type, bbox, cuts: [] });
      return { ...p, lines };
    });
    selectLine(newUid);
  };

  // ── persistence (fire-and-forget: never blocks navigation) ──────────────────
  function persist(input: BulkSaveInput): Promise<ReviewData | null> {
    return bulkSavePages(mushafId, input)
      .then((fresh) => {
        queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.stats(mushafId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushafId) });
        return fresh;
      })
      .catch((e) => {
        toast.error(e instanceof ApiError ? e.message : t("review.saveFailed"));
        return null;
      });
  }

  // Re-sync saved pages from the server's authoritative bulk-save response — the
  // backend is the source of truth between saves. A page edited DURING the save
  // (its signature no longer matches what we sent) is left local + dirty for the
  // next save; only cleanly round-tripped pages adopt the server version.
  function reconcileSaved(fresh: ReviewData, sent: Map<number, string>) {
    const freshByNum = new Map(fresh.pages.map((p) => [p.page_number, p]));
    const rebuilt = new Map<number, EditPage>();
    sent.forEach((_sig, n) => {
      const fp = freshByNum.get(n);
      if (fp) rebuilt.set(n, editPageFromApiPage(fp));
    });
    // Baseline = the server version's signature: reconciled pages become clean,
    // while a page re-edited mid-save keeps a different local signature → dirty.
    rebuilt.forEach((ep, n) => baselineRef.current.set(n, pageSignature(ep)));
    setHist((h) => {
      const cur = h.stack[h.index];
      if (!cur) return h;
      const pages = cur.pages.map((p) => {
        const sig = sent.get(p.page_number);
        if (sig === undefined || pageSignature(p) !== sig) return p;
        return rebuilt.get(p.page_number) ?? p;
      });
      const stack = h.stack.slice();
      stack[h.index] = { ...cur, pages };
      return { stack, index: h.index };
    });
  }

  // Mark reviewed is CLIENT-ONLY (persisted later by Save) → instant navigation.
  function markReviewedAndNext() {
    if (!store || !derived) return;
    const span = suraSpanPages(derived, page);
    const targets = new Set([page, ...span]);
    applyStore({
      ...store,
      pages: store.pages.map((p) => (targets.has(p.page_number) ? { ...p, reviewed: true } : p)),
    });
    if (span.length)
      toast.success(t("review.markedReviewed", { from: Math.min(...targets), to: page }));
    goto(page + 1);
  }

  function saveChanges() {
    if (!store || !derived || saving) return;
    const contentDirty = dirtyPages;
    const reviewedToSave = reviewedPending;
    if (!contentDirty.length && !reviewedToSave.length) {
      toast.info(t("review.nothingToSave"));
      return;
    }
    // Capture what we send so edits made after clicking Save stay dirty.
    const sent = new Map(
      contentDirty.map((n) => [n, pageSignature(store.pages.find((p) => p.page_number === n)!)]),
    );
    const pages = contentDirty.map((n) => {
      const ep = store.pages.find((p) => p.page_number === n)!;
      const dp = derived.pages.find((p) => p.page_number === n)!;
      return toApiPage(ep, dp);
    });
    setSaving(true);
    persist({ pages, reviewed_pages: reviewedToSave }).then((fresh) => {
      setSaving(false);
      if (!fresh) return;
      reconcileSaved(fresh, sent);
      reviewedToSave.forEach((n) => baselineReviewedRef.current.add(n));
      setBaselineVersion((v) => v + 1);
      toast.success(
        reviewedToSave.length
          ? t("review.savedToastReviewed", {
              count: pages.length,
              reviewed: reviewedToSave.length,
            })
          : t("review.savedToast", { count: pages.length }),
      );
    });
  }

  function nextWarningPage() {
    if (!derived) return;
    const ordered = derived.pages.filter((p) => p.warnings > 0).map((p) => p.page_number);
    const target = ordered.find((n) => n > page) ?? ordered[0];
    if (target != null) goto(target);
  }

  const tourSteps: TourStep[] = [
    { target: "review-canvas", title: t("tour.review.t1_title"), body: t("tour.review.t1_body") },
    { target: "review-lines", title: t("tour.review.t2_title"), body: t("tour.review.t2_body") },
    { target: "review-save", title: t("tour.review.t3_title"), body: t("tour.review.t3_body") },
  ];
  const tour = useStepTour("review", tourSteps, (mushaf?.reviewed_page_count ?? 1) === 0);

  if (!mushaf) return null;

  // Plain instructions, not a checklist — reviewing a page isn't a linear
  // tick-list (you revisit lines, split, renumber), so nothing is "done" here.
  const guideItems = [
    { label: t("guide.review.s1") },
    { label: t("guide.review.s2") },
    { label: t("guide.review.s3") },
    { label: t("guide.review.s4") },
    { label: t("guide.review.s5") },
  ];
  const status = !store ? undefined : unsavedCount > 0 ? (
    <StatusLine>{t("stepStatus.reviewUnsaved", { count: unsavedCount })}</StatusLine>
  ) : derived && derived.totalWarnings > 0 ? (
    <StatusLine tone="warning">
      {t("stepStatus.reviewWarnings", { count: derived.totalWarnings })}
    </StatusLine>
  ) : (
    <StatusLine tone="success">{t("stepStatus.reviewClean")}</StatusLine>
  );

  const statusSlot = (
    <div className="flex items-center gap-2 text-[11.5px]">
      {unsavedCount > 0 && (
        <span className="font-medium text-orange">
          {t("review.unsaved", { count: unsavedCount })}
        </span>
      )}
      {derived && derived.totalWarnings > 0 && (
        <button
          type="button"
          onClick={nextWarningPage}
          title={t("review.warningTitle")}
          className="cursor-pointer rounded-sm border border-[color:var(--warning-border)] bg-warning-bg px-1.5 py-0.5 font-medium text-[#8a4b0d]"
        >
          ⚠ {derived.totalWarnings}
        </button>
      )}
      <div className="flex h-[26px] overflow-hidden rounded-sm border-[1.5px] border-border-strong">
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          title={t("review.undoTitle")}
          className="cursor-pointer border-r border-border bg-white px-2 text-text-secondary hover:bg-bg-surface disabled:opacity-40"
        >
          ↶
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          title={t("review.redoTitle")}
          className="cursor-pointer bg-white px-2 text-text-secondary hover:bg-bg-surface disabled:opacity-40"
        >
          ↷
        </button>
      </div>
    </div>
  );

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <div data-tour="review-canvas" className="relative flex flex-1 overflow-hidden">
        <ReviewEditCanvas
          imageUrl={pageImageUrl(mushafId, page)}
          lines={currentDerived?.lines ?? []}
          selectedUid={selectedUid}
          onSelectLine={selectLine}
          selectedCut={selectedCut}
          onSelectCut={selectCut}
          onRemoveCut={removeCut}
          removeSepTitle={t("review.removeSeparator")}
          onUpdateLineBbox={updateLineBbox}
          onAddCut={addCut}
          onMoveCut={moveCut}
          page={page}
          pageCount={logicalCount}
          onPageChange={goto}
          processed={railProcessed}
          reviewed={railReviewed}
          onNatural={setNatural}
          statusSlot={statusSlot}
        />
        <CanvasHelp
          guideItems={guideItems}
          guideAbout={t("guide.aboutStatic")}
          coachText={t("coach.review")}
          onReplayTour={tour.start}
        />
      </div>

      <Aside
        status={status}
        footer={
          <div data-tour="review-save" className="flex flex-col gap-2">
            <Button onClick={markReviewedAndNext} disabled={!store}>
              {t("review.markReviewedNext")}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={saveChanges}
                disabled={unsavedCount === 0 || saving}
              >
                {saving ? t("common.saving") : t("review.saveChanges")}
              </Button>
              <Button asChild variant="outline" className="flex-1">
                <Link to="/mushafs/$mushafId/finalize" params={{ mushafId }} search={{ page }}>
                  {t("review.finalize")}
                </Link>
              </Button>
            </div>
          </div>
        }
      >
        {!store ? (
          <Hint>{t("review.loadingData")}</Hint>
        ) : (
          <>
            {currentDerived && (
              <div className="rounded-md border border-border bg-white px-2.5 py-1.5 text-[11.5px] text-text-secondary">
                {t("review.enters", {
                  fromSura: suraName(currentDerived.entry.sura),
                  fromAya: currentDerived.entry.aya,
                  toSura: suraName(currentDerived.exit.sura),
                  toAya: Math.max(1, currentDerived.exit.aya - 1),
                })}
                {currentEdit?.reviewed && (
                  <span className="ms-1 font-semibold text-success">{t("review.reviewedTag")}</span>
                )}
                {currentDerived.warnings > 0 && (
                  <span className="ms-1 font-semibold text-[#8a4b0d]">
                    {t("review.warnTag", { count: currentDerived.warnings })}
                  </span>
                )}
              </div>
            )}

            <div data-tour="review-lines" className="flex flex-col gap-3">
              <LineNavigator
                lines={currentDerived?.lines ?? []}
                selectedUid={selectedUid}
                onSelect={selectLine}
                onAdd={() => addLineAfter(selectedUid, "text")}
              />

              {selectedEdit && selectedDerived ? (
                <SelectedLineEditor
                  edit={selectedEdit}
                  derived={selectedDerived}
                  suras={suras ?? []}
                  selectedCutIndex={
                    selectedCut?.uid === selectedEdit.uid ? selectedCut.index : null
                  }
                  onSetType={(t) => setLineType(selectedEdit.uid, t)}
                  onSetSura={(n) => setSura(selectedEdit.uid, n)}
                  onUpdateBbox={(b) => updateLineBbox(selectedEdit.uid, b)}
                  onDelete={() => deleteLine(selectedEdit.uid)}
                  onSelectCut={(i) => selectCut(selectedEdit.uid, i)}
                  onRemoveCut={(i) => removeCut(selectedEdit.uid, i)}
                  onAddCut={() =>
                    addCut(selectedEdit.uid, selectedEdit.bbox.x + selectedEdit.bbox.w / 2)
                  }
                />
              ) : (
                <p className="py-4 text-center text-[12px] text-text-muted">
                  {currentEdit && currentEdit.lines.length === 0
                    ? t("review.blankPage")
                    : t("review.selectLine")}
                </p>
              )}
            </div>
          </>
        )}
      </Aside>

      <TourOverlay tour={tour} />
    </div>
  );
}

// ── sidebar sub-components ────────────────────────────────────────────────────

/** Short summary of a line for the navigator: the ayat it covers for a text
 * line (no "segments" jargon), the sura for a header/besmella. */
function useLineSummary() {
  const { t } = useTranslation();
  return (l: DerivedLine) => {
    if (l.type !== "text") return t("review.suraSummary", { sura: l.sura });
    if (!l.segments.length) return t("common.dash");
    const from = l.segments[0].aya;
    const to = l.segments[l.segments.length - 1].aya;
    return from === to ? t("review.lineAya", { n: from }) : t("review.lineAyaRange", { from, to });
  };
}

/** Compact line stepper: prev/next through the page's lines with the current
 * one summarised, plus a single add-line button (type is set in the editor). */
function LineNavigator({
  lines,
  selectedUid,
  onSelect,
  onAdd,
}: {
  lines: DerivedLine[];
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const summarize = useLineSummary();
  const total = lines.length;
  const idx = lines.findIndex((l) => l.uid === selectedUid);
  // Before the auto-select effect runs, fall back to the first line for display.
  const safeIdx = idx >= 0 ? idx : 0;
  const current: DerivedLine | undefined = lines[safeIdx];
  const color = current ? TYPE_COLOR[current.type] : "var(--orange)";

  return (
    <div className="overflow-hidden rounded-md border border-border bg-white">
      <div className="flex items-center justify-between border-b border-border bg-orange-tint px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-orange">
          {t("review.linesTitle")}
        </span>
        <button
          type="button"
          onClick={onAdd}
          className="flex cursor-pointer items-center gap-1 rounded-sm border-[1.5px] border-orange bg-white px-2 py-[3px] text-[11px] font-semibold text-orange hover:bg-orange hover:text-white"
        >
          <Plus size={12} /> {t("review.addLine")}
        </button>
      </div>

      {total === 0 || !current ? (
        <p className="px-3 py-3 text-[12px] text-text-muted">{t("review.noLines")}</p>
      ) : (
        <div className="flex items-stretch">
          <NavArrow
            dir="up"
            title={t("review.prevLine")}
            disabled={safeIdx <= 0}
            onClick={() => onSelect(lines[safeIdx - 1].uid)}
          />
          <button
            type="button"
            onClick={() => onSelect(current.uid)}
            className="flex flex-1 flex-col gap-1 border-x border-border px-3 py-2 text-start transition-colors cursor-pointer"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = `color-mix(in oklab, ${color} 8%, transparent)`)
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = "")}
          >
            <span className="flex items-center justify-between w-full gap-2">
              <span className="font-mono text-[12px] font-semibold" style={{ color }}>
                {t("review.linePosition", { n: current.line_number, total })}
              </span>
              <TypeChip type={current.type} />
            </span>
            <span className="truncate text-[11.5px] text-text-secondary">{summarize(current)}</span>
          </button>
          <NavArrow
            dir="down"
            title={t("review.nextLine")}
            disabled={safeIdx >= total - 1}
            onClick={() => onSelect(lines[safeIdx + 1].uid)}
          />
        </div>
      )}
    </div>
  );
}

function NavArrow({
  dir,
  title,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex w-10 flex-none cursor-pointer items-center justify-center transition-colors bg-bg-surface text-navy hover:bg-transparent disabled:cursor-not-allowed disabled:text-text-muted disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {dir === "up" ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
    </button>
  );
}

function SelectedLineEditor({
  edit,
  derived,
  suras,
  selectedCutIndex,
  onSetType,
  onSetSura,
  onUpdateBbox,
  onDelete,
  onSelectCut,
  onRemoveCut,
  onAddCut,
}: {
  edit: EditLine;
  derived: DerivedLine;
  suras: Sura[];
  /** Index of the separator selected on this line, or null. */
  selectedCutIndex: number | null;
  onSetType: (t: EditLineType) => void;
  onSetSura: (n: number) => void;
  onUpdateBbox: (b: Rect) => void;
  onDelete: () => void;
  onSelectCut: (i: number) => void;
  onRemoveCut: (i: number) => void;
  onAddCut: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-white p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t("review.lineN", { n: derived.line_number })}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="cursor-pointer rounded-sm border border-error-border bg-error-bg px-2 py-[3px] text-[11px] font-medium text-error hover:brightness-95"
        >
          {t("review.deleteLine")}
        </button>
      </div>

      <Field label={t("review.typeLabel")}>
        <select
          value={edit.type}
          onChange={(e) => onSetType(e.target.value as EditLineType)}
          className="h-8 w-full cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-[12.5px]"
        >
          {LINE_TYPE_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`review.type_${value}`)}
            </option>
          ))}
        </select>
      </Field>

      {edit.type === "sura_header" && (
        <Field label={t("review.suraAnchorLabel")}>
          <select
            value={edit.sura ?? derived.sura}
            onChange={(e) => onSetSura(Number(e.target.value))}
            className="h-8 w-full cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-[12.5px]"
          >
            {suras.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}. {s.transliteration}
              </option>
            ))}
          </select>
        </Field>
      )}

      {edit.type === "besmella" && (
        <div className="rounded-sm border border-border bg-bg-surface px-2.5 py-1.5 text-[11.5px] text-text-secondary">
          {t("review.besmellaNote", { sura: derived.sura })}
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t("review.bbox")}
        </div>
        <RectInputs rect={edit.bbox} onChange={onUpdateBbox} />
      </div>

      {edit.type === "text" && (
        <ListCard
          title={t("review.separatorsTitle")}
          count={edit.cuts.length}
          empty={t("review.separatorsEmpty")}
          footer={
            <button
              type="button"
              onClick={onAddCut}
              className="mt-1.5 flex w-full cursor-pointer items-center justify-center gap-1 rounded-sm border-[1.5px] border-dashed border-border-strong px-2 py-[4px] text-[11px] font-medium text-text-secondary transition-colors hover:border-orange hover:bg-orange-tint hover:text-orange"
            >
              <Plus size={12} /> {t("review.addSeparator")}
            </button>
          }
        >
          {edit.cuts.map((cx, i) => {
            const sel = i === selectedCutIndex;
            return (
              <li key={i} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelectCut(i)}
                  className={[
                    "flex flex-1 items-center gap-2 rounded-sm px-1.5 py-[3px] text-start text-[11.5px]",
                    sel ? "bg-orange-tint text-orange" : "hover:bg-bg-surface",
                  ].join(" ")}
                >
                  <span className="w-4 text-text-muted">{i + 1}.</span>
                  <span className="font-mono">{t("review.separatorX", { x: Math.round(cx) })}</span>
                </button>
                <IconX title={t("review.removeSeparator")} onClick={() => onRemoveCut(i)} />
              </li>
            );
          })}
        </ListCard>
      )}
    </div>
  );
}

function ListCard({
  title,
  count,
  empty,
  children,
  footer,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
  /** Rendered at the very bottom of the card, regardless of count. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-white p-2">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <span>{title}</span>
        <span className="font-normal normal-case">{count}</span>
      </div>
      {count === 0 ? (
        <p className="py-1 text-[11.5px] text-text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">{children}</ul>
      )}
      {footer}
    </div>
  );
}

function IconX({
  title,
  onClick,
  className,
}: {
  title: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`cursor-pointer rounded-sm border bg-white p-[5px] text-[10.5px] text-error hover:bg-error-bg hover:brightness-95 ${className ?? ""}`}
    >
      <Trash2 size={14} />
    </button>
  );
}

function TypeChip({ type }: { type: EditLineType }) {
  const { t } = useTranslation();
  return (
    <span
      className="rounded-pill px-[6px] py-[1px] text-[9.5px] font-semibold uppercase tracking-wider text-white"
      style={{ background: TYPE_COLOR[type] }}
    >
      {t(`review.chip_${type}`)}
    </span>
  );
}

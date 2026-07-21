import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Field, Hint, StatusLine } from "@/components/app/Panel";
import { StepGuide } from "@/components/app/StepGuide";
import { CanvasCoach } from "@/components/app/CanvasCoach";
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
  cutIndexAt,
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
  const [saving, setSaving] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Bumped when the saved baseline changes without the store changing (post-save).
  const [baselineVersion, setBaselineVersion] = useState(0);

  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  const baselineRef = useRef<Map<number, string>>(new Map());
  const baselineReviewedRef = useRef<Set<number>>(new Set());
  const builtForRef = useRef<string | null>(null);

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
  const addCut = (uid: string, x: number) => {
    const line = currentEdit?.lines.find((l) => l.uid === uid);
    if (line) updateLine(uid, { cuts: [...line.cuts, Math.round(x)] });
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
  };
  const removeSegment = (uid: string, segIndex: number) => {
    const el = currentEdit?.lines.find((l) => l.uid === uid);
    const dl = currentDerived?.lines.find((l) => l.uid === uid);
    if (!el || !dl) return;
    if (dl.segments.length <= 1) {
      updateLine(uid, { cuts: [] });
      return;
    }
    const seg = dl.segments[segIndex];
    // Merge: drop the cut on this segment's separator edge (its left, or — for
    // the leftmost/open segment — its right).
    const boundaryX = seg.has_separator ? seg.bbox.x : seg.bbox.x + seg.bbox.w;
    const ci = cutIndexAt(el.bbox, el.cuts, boundaryX);
    if (ci >= 0) updateLine(uid, { cuts: el.cuts.filter((_, idx) => idx !== ci) });
  };

  const setLineType = (uid: string, type: EditLineType) =>
    updateLine(uid, {
      type,
      cuts: type === "text" ? (currentEdit?.lines.find((l) => l.uid === uid)?.cuts ?? []) : [],
      sura:
        type === "sura_header" ? currentEdit?.lines.find((l) => l.uid === uid)?.sura : undefined,
    });

  // Anchor the running sura at a header (propagates forward until the next anchor).
  const setSura = (uid: string, sura: number) => updateLine(uid, { sura });

  const deleteLine = (uid: string) => {
    mutatePage((p) => ({ ...p, lines: p.lines.filter((l) => l.uid !== uid) }));
    if (selectedUid === uid) setSelectedUid(null);
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
    setSelectedUid(newUid);
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
  const tour = useStepTour("review", tourSteps);

  if (!mushaf) return null;

  const guideItems = [
    { label: t("guide.review.s1"), done: !!currentEdit?.reviewed },
    { label: t("guide.review.s2") },
    { label: t("guide.review.s3") },
    { label: t("guide.review.s4"), done: unsavedCount === 0 && !!currentEdit?.reviewed },
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
          onSelectLine={setSelectedUid}
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
        <CanvasCoach storageKey="review" text={t("coach.review")} />
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
            <StepGuide items={guideItems} storageKey="review" onReplayTour={tour.start} />

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

            <div data-tour="review-lines">
              <LineList
                lines={currentDerived?.lines ?? []}
                selectedUid={selectedUid}
                onSelect={setSelectedUid}
                onAdd={(type) => addLineAfter(selectedUid, type)}
              />
            </div>

            {selectedEdit && selectedDerived ? (
              <SelectedLineEditor
                edit={selectedEdit}
                derived={selectedDerived}
                suras={suras ?? []}
                onSetType={(t) => setLineType(selectedEdit.uid, t)}
                onSetSura={(n) => setSura(selectedEdit.uid, n)}
                onUpdateBbox={(b) => updateLineBbox(selectedEdit.uid, b)}
                onDelete={() => deleteLine(selectedEdit.uid)}
                onRemoveCut={(i) => removeCut(selectedEdit.uid, i)}
                onRemoveSegment={(i) => removeSegment(selectedEdit.uid, i)}
              />
            ) : (
              <p className="py-4 text-center text-[12px] text-text-muted">
                {currentEdit && currentEdit.lines.length === 0
                  ? t("review.blankPage")
                  : t("review.selectLine")}
              </p>
            )}
          </>
        )}
      </Aside>

      <TourOverlay tour={tour} />
    </div>
  );
}

// ── sidebar sub-components ────────────────────────────────────────────────────

function LineList({
  lines,
  selectedUid,
  onSelect,
  onAdd,
}: {
  lines: DerivedLine[];
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  onAdd: (type: EditLineType) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-white">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <span>{t("review.linesTitle")}</span>
        <span className="font-normal normal-case">
          {t("review.linesTotal", { count: lines.length })}
        </span>
      </div>
      <ul className="max-h-[240px] overflow-y-auto">
        {lines.map((l) => {
          const active = l.uid === selectedUid;
          const summary =
            l.type === "text"
              ? l.segments.length
                ? t("review.segSummaryAya", {
                    count: l.segments.length,
                    from: l.segments[0].aya,
                    to: l.segments[l.segments.length - 1].aya,
                  })
                : t("review.segSummary", { count: l.segments.length })
              : t("review.suraSummary", { sura: l.sura });
          const hasWarn = l.boundaryWarning || l.segments.some((s) => s.overflow);
          return (
            <li key={l.uid}>
              <button
                type="button"
                onClick={() => onSelect(l.uid)}
                className={[
                  "flex w-full items-center gap-2 border-b border-border px-3 py-[7px] text-start text-[12px]",
                  active ? "bg-orange-tint" : "bg-white hover:bg-bg-surface",
                ].join(" ")}
              >
                <span className="w-5 font-mono text-text-muted">{l.line_number}</span>
                <TypeChip type={l.type} />
                <span className="ms-auto truncate text-[11.5px] text-text-secondary">
                  {summary}
                </span>
                {hasWarn && <span className="h-1.5 w-1.5 flex-none rounded-full bg-warning" />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-1 border-t border-border bg-bg-surface px-3 py-2">
        {LINE_TYPE_VALUES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onAdd(value)}
            className="flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 py-[5px] text-[11px] font-medium text-text-secondary hover:bg-bg-surface"
          >
            + {t(`review.type_${value}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectedLineEditor({
  edit,
  derived,
  suras,
  onSetType,
  onSetSura,
  onUpdateBbox,
  onDelete,
  onRemoveCut,
  onRemoveSegment,
}: {
  edit: EditLine;
  derived: DerivedLine;
  suras: Sura[];
  onSetType: (t: EditLineType) => void;
  onSetSura: (n: number) => void;
  onUpdateBbox: (b: Rect) => void;
  onDelete: () => void;
  onRemoveCut: (i: number) => void;
  onRemoveSegment: (i: number) => void;
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
        <>
          <ListCard
            title={t("review.segmentsTitle")}
            count={derived.segments.length}
            empty={t("review.segmentsEmpty")}
          >
            {derived.segments.map((s, i) => (
              <li key={`${i}_${s.bbox.x}`} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-4 text-text-muted">{i + 1}.</span>
                <span className={`font-medium ${s.overflow ? "text-error" : "text-text-primary"}`}>
                  {t("review.ayaN", { n: s.aya })}
                  {!s.has_separator ? t("review.ayaCont") : ""}
                  {s.overflow ? " ⚠" : ""}
                </span>
                <span className="ms-auto font-mono text-text-muted">
                  {Math.round(s.bbox.x)}·{Math.round(s.bbox.w)}
                </span>
                <IconX title={t("review.removeSegment")} onClick={() => onRemoveSegment(i)} />
              </li>
            ))}
          </ListCard>

          <ListCard
            title={t("review.separatorsTitle")}
            count={edit.cuts.length}
            empty={t("review.separatorsEmpty")}
          >
            {edit.cuts.map((cx, i) => (
              <li key={i} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-4 text-text-muted">{i + 1}.</span>
                <span className="font-mono">{t("review.separatorX", { x: Math.round(cx) })}</span>
                <IconX
                  title={t("review.removeSeparator")}
                  onClick={() => onRemoveCut(i)}
                  className="ms-auto"
                />
              </li>
            ))}
          </ListCard>
        </>
      )}
    </div>
  );
}

function ListCard({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
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
      className={`cursor-pointer rounded-sm border border-border-strong bg-white px-[5px] text-[10.5px] text-text-secondary hover:bg-bg-surface ${className ?? ""}`}
    >
      ✕
    </button>
  );
}

function TypeChip({ type }: { type: EditLineType }) {
  const { t } = useTranslation();
  const colors: Record<EditLineType, string> = {
    sura_header: "var(--navy)",
    besmella: "var(--success)",
    text: "var(--orange)",
  };
  return (
    <span
      className="rounded-pill px-[6px] py-[1px] text-[9.5px] font-semibold uppercase tracking-wider text-white"
      style={{ background: colors[type] }}
    >
      {t(`review.chip_${type}`)}
    </span>
  );
}

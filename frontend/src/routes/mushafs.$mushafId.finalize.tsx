import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Hint, StatusLine, StepBody } from "@/components/app/Panel";
import { CanvasHelp } from "@/components/app/CanvasHelp";
import { useLeaveGuard } from "@/components/app/LeaveGuard";
import { InfoTip } from "@/components/app/InfoTip";
import { ExportedLineDialog, type ExportedLine } from "@/components/app/ExportedLineDialog";
import { LineNavigator } from "@/components/app/LineNavigator";
import { BusyLabel } from "@/components/app/SatrLoader";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { FinalizeCanvas, type CanvasLine } from "@/components/canvas/FinalizeCanvas";
import {
  API_BASE,
  ApiError,
  exportLines,
  finalizePage,
  linesZipUrl,
  markLinesFinalized,
  pageImageUrl,
  queryKeys,
  useMushaf,
  usePage,
  useProcessedPages,
  type EraseStroke,
  type FinalizeLine,
  type LineType,
  type PageData,
  type Rect,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/finalize")({
  validateSearch: (s: Record<string, unknown>) => ({ page: Math.max(1, Number(s.page) || 1) }),
  component: FinalizePage,
});

type EditLine = {
  line_number: number;
  type: LineType;
  bbox: Rect;
  strokes: EraseStroke[];
  /** Cut the ink reaching over the line's top or bottom edge (a neighbour's). */
  eraseEdgeInk: boolean;
  /** Padding added to this line since the page was loaded (see `growLine`). Kept
   * on the line so undo and redo carry the number back with the box. */
  pad: number;
};

/** Ceiling for the page-wide padding field (px above and below each line). */
const PAD_MAX = 200;
const PAD_STEP = 2;
const PAD_MIN = -200;

/** Build the editable model. X/W are forced to the page crop box so every line
 * shares the same width and left edge; only Y/H stay per-line. */
function fromPageData(data: PageData | undefined): EditLine[] {
  if (!data) return [];
  const col = data.bbox;
  return data.lines.map((l) => ({
    line_number: l.line_number,
    type: l.type,
    bbox: {
      x: col ? col.x : l.bbox_x,
      y: l.bbox_y,
      w: col ? col.w : l.bbox_w,
      h: l.bbox_h,
    },
    strokes: (l.erase_strokes ?? []).map((s) => ({ brush_size: s.brush_size, points: s.points })),
    eraseEdgeInk: l.erase_edge_ink ?? false,
    pad: 0,
  }));
}

/** Grow (negative: shrink) a line by `delta` px on its top AND bottom edge, and
 * count it in the line's padding. Applied over the current box, so a trim made
 * in between survives; a line pinned at the page's top edge still grows
 * downward, and none grows past the page's bottom (`pageHeight`, once known). */
function growLine(line: EditLine, delta: number, pageHeight: number | null): EditLine {
  const y = Math.max(0, line.bbox.y - delta);
  const grewTop = line.bbox.y - y;
  const maxH = pageHeight != null ? pageHeight - y : Number.MAX_SAFE_INTEGER;
  const h = Math.min(maxH, Math.max(1, line.bbox.h + grewTop + delta));
  return { ...line, pad: line.pad + delta, bbox: { ...line.bbox, y, h } };
}

function lineSig(l: EditLine): string {
  const strokes = l.strokes
    .map((s) => `${s.brush_size}#${s.points.map((p) => `${p[0]},${p[1]}`).join(";")}`)
    .join("~");
  return `${l.bbox.x},${l.bbox.y},${l.bbox.w},${l.bbox.h}|${strokes}|${l.eraseEdgeInk ? 1 : 0}`;
}

function signLines(lines: EditLine[]): Map<number, string> {
  return new Map(lines.map((l) => [l.line_number, lineSig(l)] as const));
}

/** The padding most of a page's lines were given since it loaded: what the page
 * as a whole got, a line or two padded apart aside. */
function findCommonPad(lines: EditLine[]): number {
  const counts = new Map<number, number>();
  for (const l of lines) counts.set(l.pad, (counts.get(l.pad) ?? 0) + 1);
  let common = 0;
  let most = 0;
  for (const [pad, count] of counts) {
    if (count > most) {
      common = pad;
      most = count;
    }
  }
  return common;
}

/** Prefix media paths (relative from the export endpoint) with a leading slash. */
function mediaSrc(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function FinalizePage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/finalize" });
  const { page } = Route.useSearch();
  const navigate = useNavigate({ from: "/mushafs/$mushafId/finalize" });
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { data: mushaf } = useMushaf(mushafId);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: pageData } = usePage(mushafId, page);

  const [model, setModel] = useState<EditLine[]>([]);
  const [baseline, setBaseline] = useState<Map<number, string>>(new Map());
  // What leaving the step would lose: the saved page, or — when the usual padding
  // was put on as it opened — the page with it. Moving on unpadded is no loss.
  const [guardBaseline, setGuardBaseline] = useState<Map<number, string>>(new Map());
  // The padding the page's lines already had when it loaded (saved with it), and
  // the usual padding put on as it opened, if it was.
  const [padBase, setPadBase] = useState(0);
  const [autoPadded, setAutoPadded] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [brushSize, setBrushSize] = useState(16);
  const [builtFor, setBuiltFor] = useState<number | null>(null);
  // Exported PNGs keep their filename when re-exported, so the browser would
  // serve the previous cut — this stamp busts that cache.
  const [pngVersion, setPngVersion] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // ── undo/redo history (one entry per committed edit) ─────────────────────────
  const historyRef = useRef<{ stack: EditLine[][]; index: number }>({ stack: [], index: -1 });
  const [, bumpHist] = useState(0);
  const forceHist = () => bumpHist((n) => n + 1);

  const commit = useCallback((next: EditLine[]) => {
    setModel(next);
    const h = historyRef.current;
    const stack = h.stack.slice(0, h.index + 1);
    stack.push(next);
    while (stack.length > 100) stack.shift();
    historyRef.current = { stack, index: stack.length - 1 };
    forceHist();
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    const index = h.index - 1;
    historyRef.current = { stack: h.stack, index };
    setModel(h.stack[index]);
    forceHist();
  }, []);
  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    const index = h.index + 1;
    historyRef.current = { stack: h.stack, index };
    setModel(h.stack[index]);
    forceHist();
  }, []);

  // The padding the latest checked pages agree on; null until the mushaf loads.
  const usualPadding = mushaf ? (mushaf.usual_line_padding ?? 0) : null;

  // Build the model once per page (a save patches the cache in place, guarded by
  // the page number so it never clobbers in-flight edits).
  useEffect(() => {
    if (!pageData || usualPadding === null || builtFor === page) return;
    const loaded = fromPageData(pageData);
    // A page whose lines were never padded here, nor checked, opens with the usual
    // padding — as an edit of its own, so it is unsaved and Ctrl+Z takes it off.
    const autoPad =
      pageData.line_padding == null && !pageData.lines_finalized && usualPadding !== 0
        ? usualPadding
        : null;
    const next = autoPad != null ? loaded.map((l) => growLine(l, autoPad, null)) : loaded;
    setModel(next);
    historyRef.current = {
      stack: autoPad != null ? [loaded, next] : [loaded],
      index: autoPad != null ? 1 : 0,
    };
    forceHist();
    setBaseline(signLines(loaded));
    setGuardBaseline(signLines(next));
    setPadBase(pageData.line_padding ?? 0);
    setAutoPadded(autoPad);
    // Nothing selected: the padding field then acts on the whole page. The view
    // still opens fitted on the first line — the canvas resets it per image.
    setSelected(null);
    setPngVersion(0);
    setViewing(null);
    setBuiltFor(page);
  }, [pageData, usualPadding, page, builtFor]);

  // The page's exported PNGs, from the server — so lines exported in an earlier
  // session show up as soon as the page opens, not only after a fresh export.
  const exportedLines: ExportedLine[] = useMemo(() => {
    const stamp = pngVersion ? `?v=${pngVersion}` : "";
    return (pageData?.lines ?? [])
      .filter((l) => l.line_png)
      .map((l) => ({ line_number: l.line_number, src: `${mediaSrc(l.line_png!)}${stamp}` }));
  }, [pageData, pngVersion]);
  const exported = useMemo(() => new Set(exportedLines.map((l) => l.line_number)), [exportedLines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
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
  }, [undo, redo]);

  const dirty = useMemo(
    () => model.some((l) => baseline.get(l.line_number) !== lineSig(l)),
    [model, baseline],
  );
  const leavingLoses = useMemo(
    () => model.some((l) => guardBaseline.get(l.line_number) !== lineSig(l)),
    [model, guardBaseline],
  );
  // The padding the page's lines carry now, saved with them: what they had when
  // the page loaded, plus what most of them were given since.
  const linePadding = padBase + findCommonPad(model);
  // Said only while the lines still carry it: Ctrl+Z takes the note off with it.
  const usualPaddingOn = autoPadded != null && findCommonPad(model) === autoPadded;

  // Save the whole page so every line's x/w lands uniformly in the DB (and export).
  const buildPayload = (): FinalizeLine[] =>
    model.map((l) => ({
      line_number: l.line_number,
      bbox_override: { ...l.bbox },
      erase_strokes: l.strokes,
      erase_edge_ink: l.eraseEdgeInk,
    }));

  const markSaved = (fresh: PageData) => {
    queryClient.setQueryData(queryKeys.page(mushafId, page), fresh);
    const saved = signLines(model);
    setBaseline(saved);
    setGuardBaseline(saved);
  };

  const exportMutation = useMutation({
    mutationFn: async () => {
      const fresh = dirty
        ? await finalizePage(mushafId, page, buildPayload(), { line_padding: linePadding })
        : null;
      const res = await exportLines(mushafId, page);
      return { fresh, res };
    },
    onSuccess: ({ fresh, res }) => {
      if (fresh) markSaved(fresh); // writes the saved page into the cache first
      // Fold the fresh PNG paths into the cached page so the panel below is
      // simply "what the server has", whether or not this session exported it.
      const urls = new Map(res.lines.map((l) => [l.line_number, l.line_png]));
      queryClient.setQueryData<PageData>(queryKeys.page(mushafId, page), (prev) =>
        prev
          ? {
              ...prev,
              lines: prev.lines.map((l) => ({
                ...l,
                line_png: urls.get(l.line_number) ?? l.line_png,
              })),
            }
          : prev,
      );
      setPngVersion(Date.now());
      queryClient.invalidateQueries({ queryKey: queryKeys.stats(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("finalize.exportedToast", { count: res.exported }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("finalize.exportFailed")),
  });

  // The tracker. Marking a page's cuts checked saves them with it, in one request,
  // and opens the next page — as Review's "Mark reviewed → next" does.
  const checked = pageData?.lines_finalized ?? false;
  const invalidateTracker = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.processedPages(mushafId) });
    // The detail carries the checked count and the usual padding.
    queryClient.invalidateQueries({ queryKey: queryKeys.mushaf(mushafId), exact: true });
  };
  const checkAndNextMutation = useMutation({
    mutationFn: () =>
      finalizePage(mushafId, page, buildPayload(), {
        line_padding: linePadding,
        lines_finalized: true,
      }),
    onSuccess: (fresh) => {
      markSaved(fresh);
      invalidateTracker();
      const last = mushaf?.logical_page_count ?? page;
      if (page < last) navigate({ search: { page: page + 1 } });
      else toast.success(t("finalize.checkedLast", { page }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("finalize.checkFailed")),
  });
  const clearCheckMutation = useMutation({
    mutationFn: () => markLinesFinalized(mushafId, page, false),
    onSuccess: (res) => {
      queryClient.setQueryData<PageData>(queryKeys.page(mushafId, page), (prev) =>
        prev ? { ...prev, lines_finalized: res.lines_finalized } : prev,
      );
      invalidateTracker();
      toast.success(t("finalize.uncheckedToast", { page }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("finalize.checkFailed")),
  });

  const busy =
    exportMutation.isPending || checkAndNextMutation.isPending || clearCheckMutation.isPending;

  const leaveDialog = useLeaveGuard({
    dirty: () => leavingLoses,
    body: t("finalize.leaveBody", { page }),
  });

  const tourSteps: TourStep[] = [
    {
      target: "finalize-canvas",
      title: t("tour.finalize.t1_title"),
      body: t("tour.finalize.t1_body"),
    },
    {
      target: "canvas-toolbar",
      title: t("tour.finalize.tools_title"),
      body: t("tour.finalize.tools_body"),
    },
    {
      target: "finalize-tools",
      title: t("tour.finalize.t2_title"),
      body: t("tour.finalize.t2_body"),
    },
    {
      target: "finalize-export",
      title: t("tour.finalize.t3_title"),
      body: t("tour.finalize.t3_body"),
    },
  ];
  const tour = useStepTour(
    "finalize",
    tourSteps,
    (mushaf?.reviewed_page_count ?? 0) < (mushaf?.logical_page_count ?? 0),
  );

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const hasLines = model.length > 0;
  const sel = model.find((l) => l.line_number === selected) ?? null;

  // Plain instructions, not a checklist: trimming is a per-line judgement call
  // you keep coming back to, so nothing here is ever really "done".
  const guideItems = [
    t("guide.finalize.s1"),
    t("guide.finalize.s2"),
    t("guide.finalize.s3"),
    t("guide.finalize.s4"),
    t("guide.finalize.s5"),
  ];
  const status = !hasLines ? (
    <StatusLine tone="warning">{t("finalize.noLines", { page })}</StatusLine>
  ) : dirty ? (
    <StatusLine>{t("finalize.unsavedStatus")}</StatusLine>
  ) : (
    <StatusLine tone="success">
      {checked ? t("finalize.checkedStatus") : t("finalize.savedStatus")}
    </StatusLine>
  );

  // live (no history) — used during an edge-drag
  const liveLine = (n: number, box: { y: number; h: number }) =>
    setModel((m) =>
      m.map((l) => (l.line_number === n ? { ...l, bbox: { ...l.bbox, ...box } } : l)),
    );

  // The padding field acts on the selected line, or on every line when none is.
  const padsLine = (l: EditLine) => selected == null || l.line_number === selected;
  const padTargets = model.filter(padsLine);
  // What the field shows: the one padding its lines share — none when they differ.
  const padShown =
    padTargets.length > 0 && padTargets.every((l) => l.pad === padTargets[0].pad)
      ? padTargets[0].pad
      : null;
  const pageHeight = natural?.h ?? null;
  // typing in the field: preview only (history lands on blur, like Y/H). Sets
  // every line it acts on to that padding, even lines that differed before.
  const livePadding = (next: number) =>
    setModel((m) =>
      m.map((l) => (padsLine(l) && l.pad !== next ? growLine(l, next - l.pad, pageHeight) : l)),
    );
  // −/+ buttons: one step on each line it acts on, keeping their differences;
  // one history entry
  const stepPadding = (step: number) =>
    commit(
      model.map((l) => {
        if (!padsLine(l)) return l;
        const next = Math.max(PAD_MIN, Math.min(PAD_MAX, l.pad + step));
        return next === l.pad ? l : growLine(l, next - l.pad, pageHeight);
      }),
    );
  // discrete (pushes history)
  const commitLine = (n: number, fn: (l: EditLine) => EditLine) =>
    commit(model.map((l) => (l.line_number === n ? fn(l) : l)));

  const revertLine = (n: number) => {
    const src = pageData?.lines.find((l) => l.line_number === n);
    if (!src) return;
    const col = pageData?.bbox;
    commitLine(n, () => ({
      line_number: src.line_number,
      type: src.type,
      bbox: {
        x: col ? col.x : src.bbox_x,
        y: src.bbox_y,
        w: col ? col.w : src.bbox_w,
        h: src.bbox_h,
      },
      strokes: (src.erase_strokes ?? []).map((s) => ({
        brush_size: s.brush_size,
        points: s.points,
      })),
      eraseEdgeInk: src.erase_edge_ink ?? false,
      pad: 0,
    }));
  };

  // Edge ink acts on the selected line, or on every line but the sura headers —
  // a header's frame can reach its box's edges, and would go with the rule.
  const edgeTargets = sel ? [sel] : model.filter((l) => l.type !== "sura_header");
  const edgeAllOn = edgeTargets.length > 0 && edgeTargets.every((l) => l.eraseEdgeInk);
  const toggleEdgeInk = () => {
    const targets = new Set(edgeTargets.map((l) => l.line_number));
    commit(model.map((l) => (targets.has(l.line_number) ? { ...l, eraseEdgeInk: !edgeAllOn } : l)));
  };

  const canvasLines: CanvasLine[] = model.map((l) => ({
    line_number: l.line_number,
    type: l.type,
    bbox: l.bbox,
    strokes: l.strokes,
    eraseEdgeInk: l.eraseEdgeInk,
    edited: baseline.get(l.line_number) !== lineSig(l),
  }));

  return (
    <StepBody>
      <div data-tour="finalize-canvas" className="relative flex flex-1 overflow-hidden">
        <FinalizeCanvas
          imageUrl={pageImageUrl(mushafId, page, mushaf.updated_at)}
          lines={canvasLines}
          selected={selected}
          brushSize={brushSize}
          page={page}
          pageCount={logicalCount}
          onPageChange={(n) =>
            navigate({ search: { page: Math.max(1, Math.min(logicalCount, n)) } })
          }
          processed={pages?.processed}
          reviewed={pages?.reviewed}
          finalized={pages?.finalized}
          label={t("canvas.pdfShort", { page: mushaf.first_quran_pdf_page + page - 1 })}
          onSelectLine={setSelected}
          onResizeLine={liveLine}
          onResizeCommit={(n, box) => commitLine(n, (l) => ({ ...l, bbox: { ...l.bbox, ...box } }))}
          onStroke={(n, stroke) =>
            commitLine(n, (l) => ({ ...l, strokes: [...l.strokes, stroke] }))
          }
          onUndo={undo}
          onRedo={redo}
          canUndo={historyRef.current.index > 0}
          canRedo={historyRef.current.index < historyRef.current.stack.length - 1}
          onNatural={setNatural}
        />
        <CanvasHelp
          guideItems={guideItems}
          coachText={t("coach.finalize")}
          onReplayTour={tour.start}
        />
      </div>

      <Aside
        meta={t("finalize.meta", { page, count: model.length })}
        status={status}
        footer={
          <div data-tour="finalize-export" className="flex flex-col gap-2.5">
            {/* The tracker. Checking is a person's word that the cuts are right; it
                saves them and opens the next page. Exporting never sets it, so an
                export to look at a result is free. */}
            <button
              type="button"
              onClick={() => checkAndNextMutation.mutate()}
              disabled={!hasLines || busy}
              className="inline-flex h-11 cursor-pointer items-center justify-center rounded-control bg-lapis text-[14px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90 disabled:cursor-default disabled:opacity-50"
            >
              {checkAndNextMutation.isPending ? (
                <BusyLabel>{t("common.saving")}</BusyLabel>
              ) : checked ? (
                t("finalize.checkedNext")
              ) : (
                t("finalize.checkNext")
              )}
            </button>
            <button
              type="button"
              onClick={() => exportMutation.mutate()}
              disabled={!hasLines || busy}
              className="inline-flex h-11 cursor-pointer items-center justify-center rounded-control border border-ink bg-transparent text-[14px] font-semibold text-ink transition-colors hover:bg-sunk disabled:cursor-default disabled:opacity-50"
            >
              {exportMutation.isPending ? (
                <BusyLabel>{t("finalize.exporting")}</BusyLabel>
              ) : (
                t("finalize.exportPage")
              )}
            </button>
            {checked && (
              <button
                type="button"
                onClick={() => clearCheckMutation.mutate()}
                disabled={busy}
                className="cursor-pointer border-0 bg-transparent p-0 text-center text-[13px] font-semibold text-ink-2 hover:underline disabled:cursor-default disabled:opacity-50"
              >
                {t("finalize.clearCheck")}
              </button>
            )}
            {/* The PNGs live under media/ until they're pulled out — this is how
                they leave the tool, saved wherever the browser asks. */}
            {exported.size > 0 ? (
              <a
                href={linesZipUrl(mushafId, page)}
                download
                className="text-center text-[13px] font-semibold text-lapis-text no-underline hover:underline"
              >
                {t("finalize.downloadZip", { count: exported.size })}
              </a>
            ) : (
              <span className="text-center text-[13px] text-ink-3" title={t("finalize.zipHint")}>
                {t("finalize.downloadZipEmpty")}
              </span>
            )}
          </div>
        }
      >
        {!hasLines ? (
          <Hint tone="warning">{t("finalize.noLines", { page })}</Hint>
        ) : (
          <>
            <LineNavigator
              lines={canvasLines.map((l) => ({
                key: String(l.line_number),
                line_number: l.line_number,
                type: l.type,
                summary: t("finalize.lineSummary", {
                  h: Math.round(l.bbox.h),
                  count: l.strokes.length,
                }),
                badges: (
                  <>
                    {l.edited && (
                      <span className="rounded-pill bg-gold px-1.5 text-[10.5px] font-semibold text-on-gold">
                        {t("finalize.edited")}
                      </span>
                    )}
                    {l.eraseEdgeInk && (
                      <span className="rounded-pill bg-sunk px-1.5 text-[10.5px] font-semibold text-ink-2">
                        {t("finalize.edgeInkBadge")}
                      </span>
                    )}
                    {exported.has(l.line_number) && (
                      <span className="rounded-pill bg-lapis-wash px-1.5 text-[10.5px] font-semibold text-lapis-text">
                        {t("finalize.png")}
                      </span>
                    )}
                  </>
                ),
              }))}
              selectedKey={selected != null ? String(selected) : null}
              onSelect={(key) => setSelected(Number(key))}
              emptyText={t("finalize.noLines", { page })}
              noneText={t("finalize.noLineSelected")}
            />

            <div data-tour="finalize-tools" className="flex flex-col gap-3.5">
              <Card
                title={
                  sel
                    ? t("finalize.paddingTitleLine", { n: sel.line_number })
                    : t("finalize.paddingTitle")
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <PadStep
                    label="−"
                    title={t("finalize.paddingLess")}
                    disabled={padTargets.every((l) => l.pad <= PAD_MIN)}
                    onClick={() => stepPadding(-PAD_STEP)}
                  />
                  <input
                    type="number"
                    min={PAD_MIN}
                    max={PAD_MAX}
                    value={padShown ?? ""}
                    placeholder="—"
                    aria-label={t("finalize.paddingLabel")}
                    onChange={(e) =>
                      livePadding(
                        Math.max(
                          PAD_MIN,
                          Math.min(PAD_MAX, Math.round(Number(e.target.value) || 0)),
                        ),
                      )
                    }
                    onBlur={() => commit(model)}
                    className="h-9 w-16 rounded-control border border-rule-2 bg-card text-center font-mono text-[14px] font-medium text-ink outline-none [appearance:textfield] focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <PadStep
                    label="+"
                    title={t("finalize.paddingMore")}
                    disabled={padTargets.every((l) => l.pad >= PAD_MAX)}
                    onClick={() => stepPadding(PAD_STEP)}
                  />
                  <span className="flex items-center gap-1 text-[12.5px] text-ink-3">
                    {sel ? t("finalize.paddingNoteLine") : t("finalize.paddingNote")}
                    <InfoTip text={t("tips.linePadding")} />
                  </span>
                </div>
                {usualPaddingOn && (
                  <span className="text-[12.5px] leading-normal text-ink-2">
                    {t("finalize.usualPaddingApplied", { px: autoPadded })}
                  </span>
                )}
              </Card>

              <Card title={t("finalize.edgeInk")} end={<InfoTip text={t("tips.edgeInk")} />}>
                <div className="flex">
                  <button
                    type="button"
                    disabled={edgeTargets.length === 0}
                    onClick={toggleEdgeInk}
                    className={`${SMALL} ${edgeAllOn ? "text-ink" : "text-stop-text"}`}
                  >
                    {edgeAllOn ? t("finalize.edgeInkRestore") : t("finalize.edgeInkErase")}
                  </button>
                </div>
                <span className="text-[12.5px] leading-normal text-ink-2">
                  {sel
                    ? t("finalize.edgeInkScopeLine", { n: sel.line_number })
                    : t("finalize.edgeInkScopePage")}
                </span>
              </Card>

              <Card
                title={t("finalize.eraser")}
                end={
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-[12.5px]">
                      {t("finalize.brushPx", { size: brushSize })}
                    </span>
                    <InfoTip text={t("tips.brush")} />
                  </span>
                }
              >
                <input
                  type="range"
                  min={2}
                  max={120}
                  value={brushSize}
                  aria-label={t("finalize.brushSize", { size: brushSize })}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-full cursor-pointer accent-stop"
                />
                <span className="text-[12.5px] leading-normal text-ink-2">
                  {sel
                    ? t("finalize.strokeInfo", { line: sel.line_number, count: sel.strokes.length })
                    : t("finalize.selectLineShort")}
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={!sel || sel.strokes.length === 0}
                    onClick={() =>
                      sel &&
                      commitLine(sel.line_number, (l) => ({
                        ...l,
                        strokes: l.strokes.slice(0, -1),
                      }))
                    }
                    className={`${SMALL} text-ink`}
                  >
                    {t("finalize.undoStroke")}
                  </button>
                  <button
                    type="button"
                    disabled={!sel || sel.strokes.length === 0}
                    onClick={() =>
                      sel && commitLine(sel.line_number, (l) => ({ ...l, strokes: [] }))
                    }
                    className={`${SMALL} text-stop-text`}
                  >
                    {t("finalize.clearLine")}
                  </button>
                </div>
              </Card>

              <Card title={t("finalize.lineBox")}>
                {sel ? (
                  <>
                    <div dir="ltr" className="grid grid-cols-2 gap-2">
                      <EditNum
                        label="Y"
                        value={sel.bbox.y}
                        onChange={(v) =>
                          liveLine(sel.line_number, { y: Math.max(0, v), h: sel.bbox.h })
                        }
                        onCommit={() => commit(model)}
                      />
                      <EditNum
                        label="H"
                        value={sel.bbox.h}
                        onChange={(v) =>
                          liveLine(sel.line_number, { y: sel.bbox.y, h: Math.max(1, v) })
                        }
                        onCommit={() => commit(model)}
                      />
                    </div>
                    <span className="text-[12px] leading-[1.45] text-ink-3">
                      {t("finalize.lockNote")}
                    </span>
                    <button
                      type="button"
                      onClick={() => revertLine(sel.line_number)}
                      className={`${SMALL} text-ink`}
                    >
                      {t("finalize.revertLine")}
                    </button>
                  </>
                ) : (
                  <p className="m-0 text-[12.5px] text-ink-3">{t("finalize.selectLineBox")}</p>
                )}
              </Card>
            </div>

            {exportedLines.length > 0 && (
              <section className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                    {t("finalize.exportedTitle", { count: exportedLines.length })}
                  </h2>
                  <span className="text-[12px] text-ink-3">{t("finalize.exportedNote")}</span>
                </div>
                <div dir="ltr" className="grid grid-cols-7 gap-[5px]">
                  {exportedLines.map((l) => (
                    <button
                      key={l.line_number}
                      type="button"
                      onClick={() => setViewing(l.line_number)}
                      title={t("finalize.viewerOpen", { n: l.line_number })}
                      aria-label={t("finalize.viewerOpen", { n: l.line_number })}
                      className="flex h-[22px] cursor-pointer items-center overflow-hidden rounded border border-rule bg-page px-[3px] transition-colors hover:border-lapis"
                    >
                      <img
                        src={l.src}
                        alt=""
                        className="max-h-full min-w-0 flex-1 object-contain"
                      />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </Aside>

      <ExportedLineDialog lines={exportedLines} current={viewing} onCurrentChange={setViewing} />
      {leaveDialog}

      <TourOverlay tour={tour} />
    </StepBody>
  );
}

/** A small outlined button in an inspector card. */
const SMALL =
  "inline-flex h-[34px] flex-1 cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card text-[12.5px] font-semibold transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-50";

/** A card of the inspector: the small uppercase title (with anything at its end),
 * then the controls. */
function Card({
  title,
  end,
  children,
}: {
  title: string;
  end?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-card border border-rule bg-card p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          {title}
        </h2>
        {end}
      </div>
      {children}
    </section>
  );
}

function PadStep({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
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
      className="h-9 w-9 flex-none cursor-pointer rounded-control border border-rule-2 bg-card font-mono text-[18px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function EditNum({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-ink-3">{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        onBlur={onCommit}
        className="h-[34px] w-full min-w-0 rounded-control border border-rule-2 bg-card px-2.5 font-mono text-[13.5px] font-medium text-ink outline-none [appearance:textfield] focus:border-lapis focus:shadow-[inset_0_0_0_1px_var(--lapis)] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </label>
  );
}

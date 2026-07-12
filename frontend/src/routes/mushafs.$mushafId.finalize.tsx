import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useBlocker, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Aside, Field, Hint, PanelCard, Section } from "@/components/app/Panel";
import { FinalizeCanvas, type CanvasLine } from "@/components/canvas/FinalizeCanvas";
import { Button } from "@/components/ui/button";
import {
  API_BASE,
  ApiError,
  exportLines,
  finalizePage,
  pageImageUrl,
  queryKeys,
  useMushaf,
  usePage,
  useProcessedPages,
  type EraseStroke,
  type ExportResult,
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
};

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
  }));
}

function lineSig(l: EditLine): string {
  const strokes = l.strokes
    .map((s) => `${s.brush_size}#${s.points.map((p) => `${p[0]},${p[1]}`).join(";")}`)
    .join("~");
  return `${l.bbox.x},${l.bbox.y},${l.bbox.w},${l.bbox.h}|${strokes}`;
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
  const { t, i18n } = useTranslation();

  const { data: mushaf } = useMushaf(mushafId);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: pageData } = usePage(mushafId, page);

  const [model, setModel] = useState<EditLine[]>([]);
  const [baseline, setBaseline] = useState<Map<number, string>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [brushSize, setBrushSize] = useState(16);
  const [exported, setExported] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ExportResult | null>(null);
  const [builtFor, setBuiltFor] = useState<number | null>(null);

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

  // Build the model once per page (a save patches the cache in place, guarded by
  // the page number so it never clobbers in-flight edits).
  useEffect(() => {
    if (!pageData || builtFor === page) return;
    const next = fromPageData(pageData);
    setModel(next);
    historyRef.current = { stack: [next], index: 0 };
    forceHist();
    setBaseline(new Map(next.map((l) => [l.line_number, lineSig(l)] as const)));
    setSelected(next[0]?.line_number ?? null);
    setExported(new Set());
    setResult(null);
    setBuiltFor(page);
  }, [pageData, page, builtFor]);

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

  // Save the whole page so every line's x/w lands uniformly in the DB (and export).
  const buildPayload = (): FinalizeLine[] =>
    model.map((l) => ({
      line_number: l.line_number,
      bbox_override: { ...l.bbox },
      erase_strokes: l.strokes,
    }));

  const markSaved = (fresh: PageData) => {
    queryClient.setQueryData(queryKeys.page(mushafId, page), fresh);
    setBaseline(new Map(model.map((l) => [l.line_number, lineSig(l)] as const)));
  };

  const saveMutation = useMutation({
    mutationFn: () => finalizePage(mushafId, page, buildPayload()),
    onSuccess: (fresh) => {
      markSaved(fresh);
      toast.success(t("finalize.cutsSaved"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("finalize.saveFailed")),
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const fresh = dirty ? await finalizePage(mushafId, page, buildPayload()) : null;
      const res = await exportLines(mushafId, page);
      return { fresh, res };
    },
    onSuccess: ({ fresh, res }) => {
      if (fresh) markSaved(fresh);
      setResult(res);
      setExported(new Set(res.lines.map((l) => l.line_number)));
      queryClient.invalidateQueries({ queryKey: queryKeys.stats(mushafId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.mushafs });
      toast.success(t("finalize.exportedToast", { count: res.exported }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("finalize.exportFailed")),
  });

  const busy = saveMutation.isPending || exportMutation.isPending;

  useBlocker({
    enableBeforeUnload: () => dirty,
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (!dirty) return false;
      return !window.confirm(t("finalize.leaveConfirm"));
    },
  });

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const hasLines = model.length > 0;
  const sel = model.find((l) => l.line_number === selected) ?? null;

  // live (no history) — used during an edge-drag
  const liveLine = (n: number, box: { y: number; h: number }) =>
    setModel((m) =>
      m.map((l) => (l.line_number === n ? { ...l, bbox: { ...l.bbox, ...box } } : l)),
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
    }));
  };

  const canvasLines: CanvasLine[] = model.map((l) => ({
    line_number: l.line_number,
    type: l.type,
    bbox: l.bbox,
    strokes: l.strokes,
    edited: baseline.get(l.line_number) !== lineSig(l),
  }));

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <FinalizeCanvas
        imageUrl={pageImageUrl(mushafId, page, mushaf.updated_at)}
        lines={canvasLines}
        selected={selected}
        brushSize={brushSize}
        page={page}
        pageCount={logicalCount}
        onPageChange={(n) => navigate({ search: { page: Math.max(1, Math.min(logicalCount, n)) } })}
        processed={pages?.processed}
        reviewed={pages?.reviewed}
        label={t("finalize.pdfPage", { pdf: mushaf.first_quran_pdf_page + page - 1 })}
        onSelectLine={setSelected}
        onResizeLine={liveLine}
        onResizeCommit={(n, box) => commitLine(n, (l) => ({ ...l, bbox: { ...l.bbox, ...box } }))}
        onStroke={(n, stroke) => commitLine(n, (l) => ({ ...l, strokes: [...l.strokes, stroke] }))}
        onUndo={undo}
        onRedo={redo}
        canUndo={historyRef.current.index > 0}
        canRedo={historyRef.current.index < historyRef.current.stack.length - 1}
      />

      <Aside
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span
                className={`h-2 w-2 rounded-full ${dirty ? "bg-orange" : "bg-success"}`}
                aria-hidden
              />
              <span className="text-text-secondary">
                {dirty ? t("finalize.unsavedStatus") : t("finalize.savedStatus")}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => saveMutation.mutate()}
                disabled={!dirty || busy}
              >
                {saveMutation.isPending ? t("common.saving") : t("finalize.saveCuts")}
              </Button>
              <Button
                className="flex-1"
                onClick={() => exportMutation.mutate()}
                disabled={!hasLines || busy}
              >
                {exportMutation.isPending ? t("finalize.exporting") : t("finalize.exportPage")}
              </Button>
            </div>
          </div>
        }
      >
        <Hint>{t("finalize.intro")}</Hint>

        {!hasLines ? (
          <Hint tone="warning">{t("finalize.noLines", { page })}</Hint>
        ) : (
          <>
            <PanelCard title={t("finalize.linesTitle", { count: model.length })}>
              <div className="-m-1 flex max-h-[220px] flex-col overflow-y-auto">
                {canvasLines.map((l) => (
                  <button
                    key={l.line_number}
                    type="button"
                    onClick={() => setSelected(l.line_number)}
                    className={`flex items-center gap-2 rounded px-2 py-[6px] text-start text-[12px] transition-colors ${
                      selected === l.line_number ? "bg-orange-tint" : "hover:bg-bg-surface"
                    }`}
                  >
                    <span className="w-5 font-mono text-text-muted">{l.line_number}</span>
                    <span className="text-text-secondary">
                      {t(`review.chip_${l.type as LineType}`)}
                    </span>
                    <span className="ms-auto flex items-center gap-1">
                      {l.edited && (
                        <span className="rounded-pill bg-orange px-1.5 text-[9px] font-bold text-white">
                          {t("finalize.edited")}
                        </span>
                      )}
                      {exported.has(l.line_number) && (
                        <span className="rounded-pill bg-navy px-1.5 text-[9px] font-bold text-white">
                          {t("finalize.png")}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </PanelCard>

            <Section title={t("finalize.eraser")}>
              <Field label={t("finalize.brushSize", { size: brushSize })}>
                <input
                  type="range"
                  min={2}
                  max={120}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-full"
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-8 flex-1 text-[11px]"
                  disabled={!sel || sel.strokes.length === 0}
                  onClick={() =>
                    sel &&
                    commitLine(sel.line_number, (l) => ({ ...l, strokes: l.strokes.slice(0, -1) }))
                  }
                >
                  {t("finalize.undoStroke")}
                </Button>
                <Button
                  variant="outline"
                  className="h-8 flex-1 text-[11px]"
                  disabled={!sel || sel.strokes.length === 0}
                  onClick={() => sel && commitLine(sel.line_number, (l) => ({ ...l, strokes: [] }))}
                >
                  {t("finalize.clearLine")}
                </Button>
              </div>
              <p className="text-[10.5px] leading-snug text-text-muted">
                {sel
                  ? t("finalize.strokeInfo", { line: sel.line_number, count: sel.strokes.length })
                  : t("finalize.selectLineShort")}
              </p>
            </Section>

            <Section title={t("finalize.lineBox")}>
              {sel ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <LockedNum label="X" value={sel.bbox.x} />
                    <LockedNum label="W" value={sel.bbox.w} />
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
                  <Button
                    variant="outline"
                    className="h-8 w-full text-[11px]"
                    onClick={() => revertLine(sel.line_number)}
                  >
                    {t("finalize.revertLine")}
                  </Button>
                  <p className="text-[10.5px] leading-snug text-text-muted">
                    {t("finalize.lockNote")}
                  </p>
                </>
              ) : (
                <p className="text-[12px] text-text-muted">{t("finalize.selectLineBox")}</p>
              )}
            </Section>

            {result && (
              <PanelCard title={t("finalize.exportedTitle", { count: result.exported })}>
                <div className="flex flex-col gap-2">
                  {result.lines.map((l) => (
                    <a
                      key={l.line_number}
                      href={mediaSrc(l.line_png)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded border border-border p-1.5 hover:border-border-strong"
                    >
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-bg-muted text-[10px] font-semibold text-text-secondary">
                        {l.line_number}
                      </span>
                      <img
                        src={mediaSrc(l.line_png)}
                        alt={t("finalize.lineAlt", { n: l.line_number })}
                        className="max-h-8 flex-1 bg-[repeating-conic-gradient(#eee_0_25%,transparent_0_50%)] bg-[length:10px_10px] object-contain"
                      />
                    </a>
                  ))}
                </div>
              </PanelCard>
            )}
          </>
        )}
      </Aside>
    </div>
  );
}

function LockedNum({ label, value }: { label: string; value: number }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-3 text-[11px] font-semibold text-text-muted">{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        disabled
        className="h-8 w-full rounded border-[1.5px] border-border bg-bg-surface px-2 text-right text-[12px] tabular-nums text-text-muted"
      />
    </label>
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
    <label className="flex items-center gap-1.5">
      <span className="w-3 text-[11px] font-semibold text-text-muted">{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        onBlur={onCommit}
        className="h-8 w-full rounded border-[1.5px] border-border-strong px-2 text-right text-[12px] tabular-nums outline-none focus:border-orange"
      />
    </label>
  );
}

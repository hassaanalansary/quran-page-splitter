import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/upload/AppHeader";
import { PageReview } from "@/components/verify/PageReview";
import {
  loadReviewResults,
  loadReviewStatus,
  pageImageUrl,
  saveReviewResults,
} from "@/lib/api/review";
import { SURAS, getSura } from "@/lib/data/suras";
import { recomputeAll } from "@/lib/verify/recompute";
import { genId, type Line, type Page, type Results, type Segment } from "@/lib/verify/types";

export const Route = createFileRoute("/verify")({
  head: () => ({
    meta: [
      { title: "Verify — Raqam" },
      {
        name: "description",
        content: "Verify and correct line/sura/aya detection on processed Mushaf pages.",
      },
    ],
  }),
  component: VerifyPage,
});

const HISTORY_LIMIT = 100;

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rectValue(value: unknown, fallback = { x: 0, y: 0, w: 1, h: 1 }) {
  if (Array.isArray(value) && value.length >= 4) {
    return {
      x: numberValue(value[0], fallback.x),
      y: numberValue(value[1], fallback.y),
      w: Math.max(1, numberValue(value[2], fallback.w)),
      h: Math.max(1, numberValue(value[3], fallback.h)),
    };
  }
  if (!isRecord(value)) return fallback;
  return {
    x: numberValue(value.x, fallback.x),
    y: numberValue(value.y, fallback.y),
    w: Math.max(1, numberValue(value.w ?? value.width, fallback.w)),
    h: Math.max(1, numberValue(value.h ?? value.height, fallback.h)),
  };
}

function cutValue(value: unknown): number | null {
  if (typeof value === "number" || typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (!isRecord(value)) return null;
  const n = Number(value.x ?? value.cx ?? value.cut_x ?? value.position ?? value.separator_x);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeCuts(line: RawRecord): number[] {
  const raw =
    line.separator_cuts ??
    line.separatorCuts ??
    line.aya_separator_cuts ??
    line.separator_positions ??
    line.separators;
  if (!Array.isArray(raw)) return [];
  return raw.map(cutValue).filter((n): n is number => n !== null);
}

function normalizeDeletedRanges(line: RawRecord): { x: number; w: number }[] {
  const raw = line.deleted_segment_ranges;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((r) => ({ x: numberValue(r.x), w: numberValue(r.w ?? r.width) }))
    .filter((r) => r.w > 0);
}

function inferCutsFromSegments(raw: unknown[], lineBBox: Line["line_bbox"]): number[] {
  return raw
    .filter(isRecord)
    .map((s) => {
      if (!s.has_separator) return null;
      const bbox = rectValue(s.bbox ?? s.segment_bbox, lineBBox);
      return Math.round(bbox.x);
    })
    .filter((n): n is number => n !== null);
}

function normalizeSegments(raw: unknown[], lineBBox: Line["line_bbox"]): Segment[] {
  return raw.filter(isRecord).map((s, i) => ({
    id: stringValue(s.id, genId("seg")),
    sura_number: numberValue(s.sura_number),
    sura_name: stringValue(s.sura_name),
    aya_number: numberValue(s.aya_number, i + 1),
    is_continuation: Boolean(s.is_continuation),
    has_separator: Boolean(s.has_separator),
    bbox: rectValue(s.bbox ?? s.segment_bbox, lineBBox),
  }));
}

function normalizeLine(rawLine: unknown, idx: number): Line {
  const raw = isRecord(rawLine) ? rawLine : {};
  const typeRaw = raw.type;
  const type: Line["type"] = typeRaw === "sura_header" || typeRaw === "basmala" ? typeRaw : "text";
  const lineBBox = rectValue(raw.line_bbox ?? raw.bbox ?? raw.box, {
    x: 0,
    y: idx * 120,
    w: 100,
    h: 80,
  });
  const line: Line = {
    id: stringValue(raw.id, genId("line")),
    line_number: numberValue(raw.line_number, idx + 1),
    slot_count: numberValue(raw.slot_count, 1),
    line_bbox: lineBBox,
    type,
    sura_number: raw.sura_number == null ? undefined : numberValue(raw.sura_number),
    sura_name: optionalStringValue(raw.sura_name),
    sura_transliteration: optionalStringValue(raw.sura_transliteration),
  };
  if (type === "text") {
    const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
    const explicitCuts = normalizeCuts(raw);
    line.separator_cuts = explicitCuts.length
      ? explicitCuts
      : inferCutsFromSegments(rawSegments, lineBBox);
    line.segments = normalizeSegments(rawSegments, lineBBox);
    line.deleted_segment_ranges = normalizeDeletedRanges(raw);
  }
  return line;
}

function normalizeResults(rawInput: unknown): Results {
  const raw = isRecord(rawInput) ? rawInput : {};
  const rawPages = Array.isArray(raw.pages) ? raw.pages : [];
  const pages: Page[] = rawPages.filter(isRecord).map((p, pageIdx) => {
    const imageFilename = stringValue(p.image_filename ?? p.filename, `page-${pageIdx + 1}.png`);
    const pageImageFilename = stringValue(p.page_image_filename, imageFilename);
    const rawLines = Array.isArray(p.lines) ? p.lines : [];
    return {
      id: stringValue(p.id, genId("page")),
      page_number: numberValue(p.page_number, pageIdx + 1),
      image_filename: imageFilename,
      page_image_filename: pageImageFilename,
      crop_box: rectValue(p.crop_box ?? p.cropBox ?? p.bounds, { x: 0, y: 0, w: 1, h: 1 }),
      lines: rawLines.map(normalizeLine),
    };
  });

  return {
    exported_at: stringValue(raw.exported_at, new Date().toISOString()),
    start_sura: numberValue(raw.start_sura, 1),
    start_aya: numberValue(raw.start_aya, 1),
    end_sura: numberValue(raw.end_sura, numberValue(raw.start_sura, 1)),
    end_aya: numberValue(raw.end_aya, numberValue(raw.start_aya, 1)),
    pages_processed: numberValue(raw.pages_processed, pages.length),
    pages,
  };
}

function withIds(raw: unknown): Results {
  const normalized = normalizeResults(raw);
  return {
    ...normalized,
    pages: normalized.pages.map((p) => ({
      ...p,
      id: p.id || genId("page"),
      lines: p.lines.map((l) => ({
        ...l,
        id: l.id || genId("line"),
        segments: l.segments?.map((s) => ({ ...s, id: s.id || genId("seg") })),
      })),
    })),
  };
}

function VerifyPage() {
  // Undo/redo history of Results snapshots.
  const [history, setHistory] = useState<Results[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const results = hIndex >= 0 ? history[hIndex] : null;

  const [pageImages, setPageImages] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" }
  >({ kind: "idle" });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const urlsRef = useRef<string[]>([]);

  useEffect(
    () => () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
    },
    [],
  );

  // Coalesce rapid same-target edits (drags) into one history entry.
  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  const COALESCE_MS = 500;

  const applyResults = useCallback(
    (next: Results, coalesceKey?: string) => {
      const computed = recomputeAll(next);
      const now = Date.now();
      const prev = coalesceRef.current;
      const shouldReplace =
        !!coalesceKey && !!prev && prev.key === coalesceKey && now - prev.at < COALESCE_MS;
      coalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;

      if (shouldReplace) {
        const updated = [...history];
        updated[hIndex] = computed;
        setHistory(updated);
        return;
      }
      const truncated = history.slice(0, hIndex + 1);
      const appended = [...truncated, computed];
      const trimmed =
        appended.length > HISTORY_LIMIT
          ? appended.slice(appended.length - HISTORY_LIMIT)
          : appended;
      setHistory(trimmed);
      setHIndex(trimmed.length - 1);
    },
    [history, hIndex],
  );

  const canUndo = hIndex > 0;
  const canRedo = hIndex >= 0 && hIndex < history.length - 1;
  const undo = useCallback(() => {
    if (canUndo) setHIndex((i) => i - 1);
  }, [canUndo]);
  const redo = useCallback(() => {
    if (canRedo) setHIndex((i) => i + 1);
  }, [canRedo]);

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Try to auto-load from the backend on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadState({ kind: "loading" });
      try {
        const status = await loadReviewStatus();
        if (!status.review_available) {
          throw new Error("Backend has no results.json yet — upload first.");
        }
        const raw = (await loadReviewResults(
          status.corrected_results ? "latest" : "original",
        )) as Results;
        if (cancelled) return;
        const withIded = withIds(raw);
        const computed = recomputeAll(withIded);
        setHistory([computed]);
        setHIndex(0);
        setPageIndex(0);
        setSelectedLineId(null);
        // Preload page images via the backend (key by page_image_filename).
        const map: Record<string, string> = {};
        for (const p of computed.pages) {
          const key = p.page_image_filename || p.image_filename;
          if (key) map[key] = pageImageUrl(key);
        }
        setPageImages(map);
        setLoadState({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        setLoadState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadResultsFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as Results;
        const computed = recomputeAll(withIds(raw));
        setHistory([computed]);
        setHIndex(0);
        setPageIndex(0);
        setSelectedLineId(null);
        setLoadState({ kind: "ready" });
      } catch (err) {
        console.error(err);
        alert("Failed to parse results.json — is the file valid JSON?");
      }
    };
    reader.readAsText(file);
  }

  function loadPageImages(list: FileList) {
    const map: Record<string, string> = { ...pageImages };
    for (const f of Array.from(list)) {
      if (!f.type.startsWith("image/")) continue;
      const url = URL.createObjectURL(f);
      urlsRef.current.push(url);
      map[f.name] = url;
    }
    setPageImages(map);
  }

  async function saveToBackend() {
    if (!results) return;
    setSaveState("saving");
    try {
      const payload = { ...results, _review_has_edits: true };
      const resp = await saveReviewResults(payload);
      // Backend may normalize fields (e.g. recompute end_sura/end_aya).
      if (resp && typeof resp === "object" && resp.data) {
        const refreshed = recomputeAll(withIds(resp.data as Results));
        setHistory([refreshed]);
        setHIndex(0);
        setSelectedLineId(null);
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      console.error(err);
      setSaveState("error");
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const page: Page | null = results?.pages[pageIndex] ?? null;
  const selectedLine = useMemo<Line | null>(() => {
    if (!page || !selectedLineId) return null;
    return page.lines.find((l) => l.id === selectedLineId) ?? null;
  }, [page, selectedLineId]);

  function mutatePage(mutator: (p: Page) => Page, coalesceKey?: string) {
    if (!results) return;
    const nextPages = results.pages.map((p, i) => (i === pageIndex ? mutator(p) : p));
    applyResults({ ...results, pages: nextPages }, coalesceKey);
  }

  function updateLine(lineId: string, patch: Partial<Line>, coalesceKey?: string) {
    mutatePage(
      (p) => ({
        ...p,
        lines: p.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)),
      }),
      coalesceKey,
    );
  }

  function deleteLine(lineId: string) {
    mutatePage((p) => ({
      ...p,
      lines: p.lines.filter((l) => l.id !== lineId),
    }));
    if (selectedLineId === lineId) setSelectedLineId(null);
  }

  function addLineAfter(lineId: string | null, type: Line["type"]) {
    mutatePage((p) => {
      const idx = lineId ? p.lines.findIndex((l) => l.id === lineId) : p.lines.length - 1;
      const ref = idx >= 0 ? p.lines[idx] : null;
      const base = ref
        ? {
            x: ref.line_bbox.x,
            y: ref.line_bbox.y + ref.line_bbox.h + 10,
            w: ref.line_bbox.w,
            h: ref.line_bbox.h,
          }
        : { x: p.crop_box.x, y: p.crop_box.y, w: p.crop_box.w, h: 120 };
      const newLine: Line = {
        id: genId("line"),
        line_number: 0, // renumbered
        slot_count: 1,
        line_bbox: { ...base },
        type,
        ...(type === "text" ? { separator_cuts: [], segments: [] } : {}),
      };
      const lines = [...p.lines];
      lines.splice(idx + 1, 0, newLine);
      return { ...p, lines };
    });
  }

  function setLineType(lineId: string, type: Line["type"]) {
    if (!page) return;
    const line = page.lines.find((l) => l.id === lineId);
    if (!line) return;
    const patch: Partial<Line> = { type };
    if (type === "text") {
      patch.separator_cuts = line.separator_cuts ?? [];
      patch.segments = line.segments ?? [];
      patch.deleted_segment_ranges = line.deleted_segment_ranges ?? [];
    } else {
      patch.separator_cuts = undefined;
      patch.segments = undefined;
      patch.deleted_segment_ranges = undefined;
    }
    updateLine(lineId, patch);
  }

  function setSuraNumber(lineId: string, n: number) {
    if (!results || !page) return;
    // The edited header is the anchor; every subsequent sura_header is bumped
    // by the same delta so the running sura sequence stays consistent.
    const target = page.lines.find((l) => l.id === lineId);
    if (!target || target.type !== "sura_header") return;
    const oldN = target.sura_number ?? n;
    const newN = Math.max(1, Math.min(114, Math.round(n)));
    const delta = newN - oldN;

    // Walk pages/lines in reading order, find the target, then bump every
    // sura_header that comes AFTER it.
    let passed = false;
    const nextPages = results.pages.map((p) => ({
      ...p,
      lines: p.lines.map((l) => {
        if (l.id === lineId) {
          passed = true;
          const info = getSura(newN);
          return {
            ...l,
            sura_number: info.number,
            sura_name: info.name,
            sura_transliteration: info.transliteration,
          };
        }
        if (passed && l.type === "sura_header" && l.sura_number != null) {
          const bumped = Math.max(1, Math.min(114, l.sura_number + delta));
          const info = getSura(bumped);
          return {
            ...l,
            sura_number: info.number,
            sura_name: info.name,
            sura_transliteration: info.transliteration,
          };
        }
        return l;
      }),
    }));
    applyResults({ ...results, pages: nextPages });
  }

  function addSeparatorAt(lineId: string, x: number) {
    if (!page) return;
    const line = page.lines.find((l) => l.id === lineId);
    if (!line || line.type !== "text") return;
    const cuts = [...(line.separator_cuts ?? []), Math.round(x)];
    updateLine(lineId, { separator_cuts: cuts });
  }
  function moveSeparator(lineId: string, cutIndex: number, x: number) {
    if (!page) return;
    const line = page.lines.find((l) => l.id === lineId);
    if (!line || !line.separator_cuts) return;
    const cuts = [...line.separator_cuts];
    cuts[cutIndex] = Math.round(x);
    updateLine(lineId, { separator_cuts: cuts }, `sep:${lineId}:${cutIndex}`);
  }
  function removeSeparator(lineId: string, cutIndex: number) {
    if (!page) return;
    const line = page.lines.find((l) => l.id === lineId);
    if (!line || !line.separator_cuts) return;
    const cuts = line.separator_cuts.filter((_, i) => i !== cutIndex);
    updateLine(lineId, { separator_cuts: cuts });
  }
  function removeSegment(lineId: string, segIndex: number) {
    // Removing a segment merges it with its right neighbour by deleting the
    // separator on its RIGHT (if any). Last (leftmost) segment: delete left
    // separator (i.e. the one at cuts[0] in left-to-right order).
    if (!page) return;
    const line = page.lines.find((l) => l.id === lineId);
    if (!line || !line.segments || !line.separator_cuts) return;
    if (line.segments.length <= 1) {
      // Nothing meaningful to remove — clear all separators.
      updateLine(lineId, { separator_cuts: [] });
      return;
    }
    // separator_cuts is sorted ASC (left-to-right). Segments are right-to-left.
    // Segment index i (0 = rightmost) corresponds to cut index (cuts.length - i)
    // on its LEFT, and cut index (cuts.length - i - 1) on its... let me map.
    // segments order (right→left): seg[0], seg[1], ..., seg[n-1]
    // cuts order (asc x):           cut[0] < cut[1] < ... < cut[n-2]
    // Boundary on RIGHT of seg[i] = cut[n-1-i] (or rightEdge if i==0).
    // Boundary on LEFT  of seg[i] = cut[n-2-i] (or leftEdge if i==n-1).
    const n = line.segments.length;
    let removeCut: number;
    if (segIndex < n - 1) {
      // remove cut on LEFT of seg[segIndex] => merges with seg[segIndex+1]
      removeCut = n - 2 - segIndex;
    } else {
      // last (leftmost) segment: remove cut on its RIGHT => merges into previous
      removeCut = n - 1 - segIndex; // = 0
    }
    const cuts = line.separator_cuts.filter((_, i) => i !== removeCut);
    updateLine(lineId, { separator_cuts: cuts });
  }

  function updateLineBbox(lineId: string, bbox: Line["line_bbox"]) {
    updateLine(lineId, { line_bbox: bbox }, `bbox:${lineId}`);
  }

  function downloadJson() {
    if (!results) return;
    const blob = new Blob([JSON.stringify(results, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "results.verified.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─────────────────── render ───────────────────

  if (!results) {
    return (
      <div className="flex h-screen flex-col">
        <AppHeader />
        <div className="flex flex-1 items-center justify-center bg-bg-page">
          <div className="flex w-[460px] flex-col gap-4 rounded-md border border-border bg-white p-6 shadow-[var(--shadow-md)]">
            <h1 className="font-display text-[20px] font-bold text-navy">Verify Detection Results</h1>
            {loadState.kind === "loading" && (
              <p className="text-[12.5px] text-text-secondary">Loading from backend…</p>
            )}
            {loadState.kind === "error" && (
              <p className="rounded-sm border border-error-border bg-error-bg px-3 py-2 text-[12px] text-error">
                Couldn't load from backend: {loadState.message}
              </p>
            )}
            <p className="text-[13px] leading-relaxed text-text-secondary">
              Or load a <code>results.json</code> manually:
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-semibold uppercase tracking-wider text-text-muted">
                results.json
              </span>
              <input
                type="file"
                accept="application/json"
                onChange={(e) => e.target.files?.[0] && loadResultsFile(e.target.files[0])}
                className="text-[12.5px]"
              />
            </label>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />

      {/* Page toolbar */}
      <header className="flex h-[44px] flex-shrink-0 items-center gap-3 border-b border-border bg-white px-4 text-[12.5px]">
        <span className="font-display text-[14px] font-bold text-navy">Verify · Page edits</span>
        <div className="ml-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
            disabled={pageIndex <= 0}
            className="h-7 cursor-pointer rounded-sm bg-transparent px-2 text-text-secondary hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            ← Prev
          </button>
          <span className="text-text-secondary">
            Page {pageIndex + 1} / {results.pages.length}
          </span>
          <button
            type="button"
            onClick={() => setPageIndex(Math.min(results.pages.length - 1, pageIndex + 1))}
            disabled={pageIndex >= results.pages.length - 1}
            className="h-7 cursor-pointer rounded-sm bg-transparent px-2 text-text-secondary hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next →
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-7 overflow-hidden rounded-sm border-[1.5px] border-border-strong">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className="cursor-pointer border-r border-border bg-white px-[10px] text-[12px] font-medium text-text-secondary hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
              className="cursor-pointer bg-white px-[10px] text-[12px] font-medium text-text-secondary hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              ↷ Redo
            </button>
          </div>
          <label className="flex h-7 cursor-pointer items-center rounded-sm border-[1.5px] border-border-strong bg-white px-[11px] text-[12px] font-medium text-text-secondary hover:bg-bg-surface">
            + Add page images
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => e.target.files && loadPageImages(e.target.files)}
              className="hidden"
            />
          </label>
          <button
            type="button"
            onClick={saveToBackend}
            disabled={saveState === "saving"}
            className="h-7 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-[13px] text-[12px] font-semibold text-navy hover:bg-bg-surface disabled:opacity-50"
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved ✓"
                : "Save to backend"}
          </button>
          <button
            type="button"
            onClick={downloadJson}
            className="h-7 cursor-pointer rounded-sm bg-navy px-[13px] text-[12px] font-semibold text-white hover:bg-navy-hover"
          >
            Download JSON
          </button>
        </div>
      </header>

      {/* Status */}
      <div className="flex h-7 flex-shrink-0 items-center gap-4 border-b border-border bg-white px-4 text-[11.5px] text-text-muted">
        <span>
          Range: sura {results.start_sura}:{results.start_aya} → sura {results.end_sura}:
          {results.end_aya}
        </span>
        <span className="ml-auto text-text-muted">
          Double-click a text line to add a separator · drag the red bars to reposition · drag the
          box body to move
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          {page && (
            <PageReview
              page={page}
              imageUrl={
                pageImages[page.page_image_filename] ?? pageImages[page.image_filename] ?? null
              }
              selectedLineId={selectedLineId}
              onSelectLine={setSelectedLineId}
              onUpdateLineBbox={updateLineBbox}
              onAddSeparatorAt={addSeparatorAt}
              onMoveSeparator={moveSeparator}
            />
          )}
        </div>

        <LineEditor
          page={page}
          selectedLine={selectedLine}
          onSelectLine={setSelectedLineId}
          onSetType={setLineType}
          onSetSura={setSuraNumber}
          onUpdateBbox={updateLineBbox}
          onAddLineAfter={addLineAfter}
          onDeleteLine={deleteLine}
          onRemoveSeparator={removeSeparator}
          onRemoveSegment={removeSegment}
        />
      </div>
    </div>
  );
}

/* ────────────────────────── sidebar editor ────────────────────────── */

function LineEditor({
  page,
  selectedLine,
  onSelectLine,
  onSetType,
  onSetSura,
  onUpdateBbox,
  onAddLineAfter,
  onDeleteLine,
  onRemoveSeparator,
  onRemoveSegment,
}: {
  page: Page | null;
  selectedLine: Line | null;
  onSelectLine: (id: string | null) => void;
  onSetType: (lineId: string, type: Line["type"]) => void;
  onSetSura: (lineId: string, n: number) => void;
  onUpdateBbox: (lineId: string, bbox: Line["line_bbox"]) => void;
  onAddLineAfter: (lineId: string | null, type: Line["type"]) => void;
  onDeleteLine: (lineId: string) => void;
  onRemoveSeparator: (lineId: string, cutIndex: number) => void;
  onRemoveSegment: (lineId: string, segIndex: number) => void;
}) {
  return (
    <aside className="flex w-[340px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-white">
      {/* Line list */}
      <div className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-white px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          <span>Lines</span>
          <span className="font-normal normal-case">{page?.lines.length ?? 0} total</span>
        </div>
        <ul>
          {page?.lines.map((l) => {
            const active = l.id === selectedLine?.id;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onSelectLine(l.id)}
                  className={[
                    "flex w-full items-center gap-2 border-b border-border px-3 py-[7px] text-left text-[12px]",
                    active ? "bg-orange-tint" : "bg-white hover:bg-bg-surface",
                  ].join(" ")}
                >
                  <span className="w-6 font-mono text-text-muted">{l.line_number}</span>
                  <TypeChip type={l.type} />
                  <span className="ml-auto truncate text-[11.5px] text-text-secondary">
                    {l.type === "sura_header"
                      ? `${l.sura_number ?? "?"} · ${l.sura_name ?? ""}`
                      : l.type === "basmala"
                        ? `sura ${l.sura_number}`
                        : `${l.segments?.length ?? 0} segs`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-1 border-b border-border bg-bg-surface px-3 py-2">
          <button
            type="button"
            onClick={() => onAddLineAfter(selectedLine?.id ?? null, "text")}
            className="flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 py-[5px] text-[11px] font-medium text-text-secondary hover:bg-white"
          >
            + Text line
          </button>
          <button
            type="button"
            onClick={() => onAddLineAfter(selectedLine?.id ?? null, "basmala")}
            className="flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 py-[5px] text-[11px] font-medium text-text-secondary hover:bg-white"
          >
            + Basmala
          </button>
          <button
            type="button"
            onClick={() => onAddLineAfter(selectedLine?.id ?? null, "sura_header")}
            className="flex-1 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 py-[5px] text-[11px] font-medium text-text-secondary hover:bg-white"
          >
            + Sura
          </button>
        </div>
      </div>

      {/* Selected line editor */}
      <div
        className="flex-shrink-0 border-t-2 border-border bg-bg-page p-3"
        style={{ maxHeight: "55%", overflowY: "auto" }}
      >
        {selectedLine ? (
          <LineDetailEditor
            line={selectedLine}
            onSetType={(t) => onSetType(selectedLine.id, t)}
            onSetSura={(n) => onSetSura(selectedLine.id, n)}
            onUpdateBbox={(b) => onUpdateBbox(selectedLine.id, b)}
            onDelete={() => onDeleteLine(selectedLine.id)}
            onRemoveSeparator={(i) => onRemoveSeparator(selectedLine.id, i)}
            onRemoveSegment={(i) => onRemoveSegment(selectedLine.id, i)}
          />
        ) : (
          <p className="py-6 text-center text-[12px] text-text-muted">
            Select a line on the page to edit it.
          </p>
        )}
      </div>
    </aside>
  );
}

function LineDetailEditor({
  line,
  onSetType,
  onSetSura,
  onUpdateBbox,
  onDelete,
  onRemoveSeparator,
  onRemoveSegment,
}: {
  line: Line;
  onSetType: (t: Line["type"]) => void;
  onSetSura: (n: number) => void;
  onUpdateBbox: (b: Line["line_bbox"]) => void;
  onDelete: () => void;
  onRemoveSeparator: (cutIndex: number) => void;
  onRemoveSegment: (segIndex: number) => void;
}) {
  function setField(k: keyof Line["line_bbox"], v: number) {
    onUpdateBbox({ ...line.line_bbox, [k]: Math.max(0, Math.round(v)) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Line {line.line_number}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="cursor-pointer rounded-sm border border-error-border bg-error-bg px-2 py-[3px] text-[11px] font-medium text-error hover:bg-error hover:text-white"
        >
          Delete line
        </button>
      </div>

      <Field label="Type">
        <select
          value={line.type}
          onChange={(e) => onSetType(e.target.value as Line["type"])}
          className="h-8 w-full cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-[12.5px]"
        >
          <option value="text">text</option>
          <option value="basmala">basmala</option>
          <option value="sura_header">sura_header</option>
        </select>
      </Field>

      {line.type === "sura_header" && (
        <Field label="Sura (anchor — rest auto-numbered)">
          <select
            value={line.sura_number ?? 1}
            onChange={(e) => onSetSura(Number(e.target.value))}
            className="h-8 w-full cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-[12.5px]"
          >
            {SURAS.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}. {s.name} — {s.transliteration}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Bounding box (px)
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k} className="flex flex-col gap-[2px]">
              <span className="text-[10.5px] font-semibold text-text-secondary">
                {k.toUpperCase()}
              </span>
              <input
                type="number"
                value={line.line_bbox[k]}
                onChange={(e) => setField(k, Number(e.target.value) || 0)}
                className="h-8 rounded-sm border-[1.5px] border-border-strong bg-white px-2 text-right text-[12.5px]"
              />
            </label>
          ))}
        </div>
      </div>

      {line.type === "text" && (
        <>
          <SegmentsEditor line={line} onRemoveSegment={onRemoveSegment} />
          <SeparatorsEditor line={line} onRemoveSeparator={onRemoveSeparator} />
        </>
      )}
    </div>
  );
}

function SegmentsEditor({
  line,
  onRemoveSegment,
}: {
  line: Line;
  onRemoveSegment: (segIndex: number) => void;
}) {
  const segs = line.segments ?? [];
  return (
    <div className="rounded-md border border-border bg-white p-2">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <span>Segments (right → left)</span>
        <span className="font-normal normal-case">{segs.length}</span>
      </div>
      {segs.length === 0 && (
        <p className="py-1 text-[11.5px] text-text-muted">
          No segments. Add separators to split the line.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {segs.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2 text-[11.5px]">
            <span className="w-4 text-text-muted">{i + 1}.</span>
            <span className="font-medium text-text-primary">
              aya {s.aya_number}
              {s.is_continuation ? " (cont.)" : ""}
            </span>
            <span className="ml-auto font-mono text-text-muted">
              {Math.round(s.bbox.x)}·{Math.round(s.bbox.w)}
            </span>
            <button
              type="button"
              onClick={() => onRemoveSegment(i)}
              title="Remove segment (merges into neighbour)"
              className="cursor-pointer rounded-sm border border-border-strong bg-white px-[5px] py-0 text-[10.5px] text-text-secondary hover:bg-bg-surface"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeparatorsEditor({
  line,
  onRemoveSeparator,
}: {
  line: Line;
  onRemoveSeparator: (cutIndex: number) => void;
}) {
  const cuts = line.separator_cuts ?? [];
  return (
    <div className="rounded-md border border-border bg-white p-2">
      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <span>Separators</span>
        <span className="font-normal normal-case">{cuts.length}</span>
      </div>
      {cuts.length === 0 && (
        <p className="py-1 text-[11.5px] text-text-muted">
          Double-click inside the line on the page to add one.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {cuts.map((cx, i) => (
          <li key={i} className="flex items-center gap-2 text-[11.5px]">
            <span className="w-4 text-text-muted">{i + 1}.</span>
            <span className="font-mono">x = {Math.round(cx)} px</span>
            <button
              type="button"
              onClick={() => onRemoveSeparator(i)}
              className="ml-auto cursor-pointer rounded-sm border border-border-strong bg-white px-[5px] py-0 text-[10.5px] text-text-secondary hover:bg-bg-surface"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function TypeChip({ type }: { type: Line["type"] }) {
  const colors: Record<Line["type"], string> = {
    sura_header: "var(--orange)",
    basmala: "var(--navy)",
    text: "var(--success)",
  };
  return (
    <span
      className="rounded-pill px-[6px] py-[1px] text-[9.5px] font-semibold uppercase tracking-wider text-white"
      style={{ background: colors[type] }}
    >
      {type === "sura_header" ? "sura" : type}
    </span>
  );
}

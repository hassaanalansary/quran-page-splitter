import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/upload/AppHeader";
import { CropPreviewPane } from "@/components/upload/CropPreviewPane";
import { FileStrip } from "@/components/upload/FileStrip";
import { PageCanvas, type CanvasTool } from "@/components/upload/PageCanvas";
import { RightPanel } from "@/components/upload/RightPanel";
import {
  cropImageToBlob,
  naturalSort,
  uploadBatch,
  type Rect,
  type Settings,
  type TargetName,
} from "@/lib/api/raqam";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Upload — Raqam" },
      {
        name: "description",
        content: "Upload scanned Mushaf pages, define crop targets, and configure detection.",
      },
    ],
  }),
  component: UploadPage,
});

/**
 * Target storage model:
 * - bounds: page coordinates re-applied to every page.
 * - sura_header / aya_separator: a captured image blob (page-independent
 *   snapshot) plus the rect used at capture time (for re-editing).
 * - *_ignore: rect stored RELATIVE to the parent template's rect (matches
 *   the old `relativeIgnoreRect` behavior — page-independent).
 */
type TargetEntry = {
  rect: Rect | null;
  blob?: Blob | null;
  blobUrl?: string | null;
  sourcePageName?: string | null;
};

type TargetMap = Record<TargetName, TargetEntry>;

const DEFAULT_TARGETS: TargetMap = {
  bounds: { rect: null },
  sura_header: { rect: null, blob: null, blobUrl: null, sourcePageName: null },
  aya_separator: { rect: null, blob: null, blobUrl: null, sourcePageName: null },
  sura_header_ignore: { rect: null },
  aya_separator_ignore: { rect: null },
};

const DEFAULT_SETTINGS: Settings = {
  padding: 4,
  expected_lines: 15,
  sura_header_slots: 1,
  sura_header_threshold: 0.6,
  max_sura_headers: 3,
  match_threshold: 0.5,
  alternate_horizontal_margin: false,
  prefer_acceleration: true,
  start_sura: 1,
  start_aya: 1,
};

/** Zoom is a multiplier (1 = 100%). The sentinel value -1 means "fit to canvas". */
type Zoom = number;

function parentTemplateOf(t: TargetName): TargetName | null {
  if (t === "sura_header_ignore") return "sura_header";
  if (t === "aya_separator_ignore") return "aya_separator";
  return null;
}

function UploadPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [targets, setTargets] = useState<TargetMap>(DEFAULT_TARGETS);
  const [activeTarget, setActiveTarget] = useState<TargetName | null>("bounds");
  const [currentRect, setCurrentRect] = useState<Rect | null>(null);
  const [drawing, setDrawing] = useState(true);
  const [zoom, setZoom] = useState<Zoom>(-1);
  const [tool, setTool] = useState<CanvasTool>("select");

  // Desktop-style shortcuts: V = select, H = hand.
  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "h" || e.key === "H") setTool("hand");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // When `activeTarget` changes, load the previously saved rect for that
  // target (if any). Otherwise keep whatever rect is already on the canvas
  // so it can be reused as a starting point for the new target.
  useEffect(() => {
    if (!activeTarget) return;
    const saved = targets[activeTarget].rect;
    if (saved) setCurrentRect(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTarget]);

  // create object URL for selected file
  const urlsRef = useRef<Map<File, string>>(new Map());
  const imageUrl = useMemo(() => {
    const f = files[selectedIndex];
    if (!f) return null;
    let u = urlsRef.current.get(f);
    if (!u) {
      u = URL.createObjectURL(f);
      urlsRef.current.set(f, u);
    }
    return u;
  }, [files, selectedIndex]);

  // revoke any captured template blob URLs on unmount
  useEffect(
    () => () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current.clear();
    },
    [],
  );

  function addFiles(list: FileList) {
    const incoming = Array.from(list).filter((f) => f.type.startsWith("image/"));
    const merged = naturalSort([...files, ...incoming]).slice(0, 610);
    setFiles(merged);
    if (files.length === 0) setSelectedIndex(0);
  }

  async function applyCrop() {
    if (!activeTarget || !currentRect) return;
    const rect = { ...currentRect };
    const selectedFile = files[selectedIndex];

    // BOUNDS — coordinate-only target.
    if (activeTarget === "bounds") {
      setTargets((t) => ({ ...t, bounds: { rect } }));
      showToast("bounds saved ✓");
      return;
    }

    // IGNORE — store as absolute page coords (same as other targets).
    // We validate it lies inside the parent template, but convert to
    // parent-relative coordinates only at upload time.
    const parentName = parentTemplateOf(activeTarget);
    if (parentName) {
      const parentRect = targets[parentName].rect;
      if (!parentRect) {
        showToast(`Apply ${parentName} first — ignore is relative to it`);
        return;
      }
      const inside =
        rect.x >= parentRect.x &&
        rect.y >= parentRect.y &&
        rect.x + rect.w <= parentRect.x + parentRect.w &&
        rect.y + rect.h <= parentRect.y + parentRect.h;
      if (!inside) {
        showToast(`Ignore must be drawn inside the ${parentName} rectangle`);
        return;
      }
      setTargets((t) => ({ ...t, [activeTarget]: { rect } }));
      showToast(`${activeTarget} saved ✓`);
      return;
    }

    // TEMPLATES (sura_header / aya_separator) — capture an image blob NOW.
    if (!selectedFile) return;
    try {
      const blob = await cropImageToBlob(selectedFile, rect);
      setTargets((t) => {
        const prev = t[activeTarget];
        if (prev.blobUrl) URL.revokeObjectURL(prev.blobUrl);
        const blobUrl = URL.createObjectURL(blob);
        return {
          ...t,
          [activeTarget]: {
            rect,
            blob,
            blobUrl,
            sourcePageName: selectedFile.name,
          },
        };
      });
      // Clear any previously saved ignore — its parent template just changed.
      const ignoreName: TargetName | null =
        activeTarget === "sura_header"
          ? "sura_header_ignore"
          : activeTarget === "aya_separator"
            ? "aya_separator_ignore"
            : null;
      if (ignoreName) {
        setTargets((t) => ({ ...t, [ignoreName]: { rect: null } }));
      }
      showToast(`${activeTarget} captured from ${selectedFile.name} ✓`);
    } catch (err) {
      console.error(err);
      showToast(`Failed to capture ${activeTarget}`);
    }
  }

  function startDrawing() {
    setDrawing(true);
    setCurrentRect(null);
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2400);
  }

  async function process() {
    if (processing) return;
    const bounds = targets.bounds.rect;
    const suraBlob = targets.sura_header.blob;
    const ayaBlob = targets.aya_separator.blob;
    if (!bounds || !suraBlob || !ayaBlob || files.length === 0) return;

    setProcessing(true);
    try {
      const toRelative = (abs: Rect | null, parent: Rect | null): Rect | null => {
        if (!abs || !parent) return null;
        return {
          x: Math.round(abs.x - parent.x),
          y: Math.round(abs.y - parent.y),
          w: Math.round(abs.w),
          h: Math.round(abs.h),
        };
      };
      const res = await uploadBatch({
        images: files,
        templates: { sura_header: suraBlob, aya_separator: ayaBlob },
        bounds,
        ignores: {
          sura_header_ignore: toRelative(targets.sura_header_ignore.rect, targets.sura_header.rect),
          aya_separator_ignore: toRelative(
            targets.aya_separator_ignore.rect,
            targets.aya_separator.rect,
          ),
        },
        settings,
      });
      if (res.ok) {
        showToast(`Processed ${files.length} pages ✓`);
      } else {
        showToast(`Upload failed (HTTP ${res.status})`);
        console.error("Raqam upload failed:", res.body);
      }
    } catch (err) {
      console.error(err);
      showToast(
        "Upload failed — is the FastAPI server running at " +
          (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000") +
          "?",
      );
    } finally {
      setProcessing(false);
    }
  }

  function resetAll() {
    // Revoke captured template URLs
    Object.values(targets).forEach((e) => {
      if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
    });
    setFiles([]);
    setTargets(DEFAULT_TARGETS);
    setSettings(DEFAULT_SETTINGS);
    setCurrentRect(null);
    setActiveTarget("bounds");
    setSelectedIndex(0);
  }

  const selectedFile = files[selectedIndex];
  const drawingTargetName = drawing && activeTarget ? activeTarget : null;

  // Preview behavior:
  //  - bounds: live page crop (no captured snapshot).
  //  - sura_header / aya_separator: show the CAPTURED blob (page-independent).
  //    If not captured yet, fall back to live page crop.
  //  - *_ignore: stacked preview — live crop of the current selection on top,
  //    parent template image (with the ignore region marked) on the bottom.
  const parentName = activeTarget ? parentTemplateOf(activeTarget) : null;
  const isIgnoreTarget = !!parentName;
  const parentEntry = parentName ? targets[parentName] : null;

  const capturedPreviewUrl = useMemo(() => {
    if (!activeTarget) return null;
    if (isIgnoreTarget) return null; // handled via ignore mode
    return targets[activeTarget].blobUrl ?? null;
  }, [activeTarget, isIgnoreTarget, targets]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas column */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Crop toolbar */}
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3">
            <ToolButton
              active={tool === "select"}
              onClick={() => setTool("select")}
              title="Select / crop tool (V)"
              aria-label="Select tool"
            >
              <CursorIcon />
            </ToolButton>
            <ToolButton
              active={tool === "hand"}
              onClick={() => setTool("hand")}
              title="Hand tool — pan the canvas (H, or hold Space)"
              aria-label="Hand tool"
            >
              <HandIcon />
            </ToolButton>
            <div className="mx-1 h-5 w-px bg-border" />
            <ToolbarPrimary active={drawing} onClick={() => setDrawing(true)} label="Draw Crop" />
            <ToolbarSecondary
              onClick={applyCrop}
              disabled={!currentRect || currentRect.w < 2}
              label="Apply"
            />
            <ToolbarGhost onClick={startDrawing} label="New" />
            <div className="ml-auto flex items-center gap-2">
              <ToolbarGhost
                onClick={() => setSelectedIndex(Math.max(0, selectedIndex - 1))}
                label="Prev"
                disabled={selectedIndex <= 0}
              />
              <ToolbarGhost
                onClick={() => setSelectedIndex(Math.min(files.length - 1, selectedIndex + 1))}
                label="Next"
                disabled={selectedIndex >= files.length - 1}
              />
              <ZoomControl value={zoom} onChange={setZoom} />
              <ToolbarDestructive
                onClick={() => {
                  if (window.confirm("Clear queue, targets, and settings back to defaults?")) {
                    resetAll();
                  }
                }}
                label="Reset"
              />
            </div>
          </div>

          {/* Canvas + Live preview split */}
          <div className="flex flex-1 overflow-hidden">
            <PageCanvas
              imageUrl={imageUrl}
              zoom={zoom}
              onZoomChange={setZoom}
              drawing={drawing}
              activeTarget={activeTarget}
              rect={currentRect}
              onRectChange={setCurrentRect}
              onCursorChange={setCursor}
              tool={tool}
            />
            <CropPreviewPane
              imageUrl={imageUrl}
              rect={currentRect}
              activeTarget={activeTarget}
              capturedUrl={capturedPreviewUrl}
              capturedSourceName={
                activeTarget ? (targets[activeTarget].sourcePageName ?? null) : null
              }
              ignore={
                isIgnoreTarget && parentEntry
                  ? {
                      parentTemplateUrl: parentEntry.blobUrl ?? null,
                      parentRect: parentEntry.rect,
                      parentName: parentName!,
                      parentSourceName: parentEntry.sourcePageName ?? null,
                      savedIgnoreRect:
                        activeTarget && targets[activeTarget].rect && parentEntry.rect
                          ? {
                              x: Math.round(targets[activeTarget].rect!.x - parentEntry.rect.x),
                              y: Math.round(targets[activeTarget].rect!.y - parentEntry.rect.y),
                              w: Math.round(targets[activeTarget].rect!.w),
                              h: Math.round(targets[activeTarget].rect!.h),
                            }
                          : null,
                    }
                  : null
              }
            />
          </div>

          {/* File strip */}
          <FileStrip
            files={files}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onAdd={addFiles}
          />

          {/* Status bar */}
          <div className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-border bg-white px-3 text-[12px] text-text-muted">
            <span>
              {files.length > 0 ? (
                <>
                  <span className="font-medium text-text-secondary">
                    Page {selectedIndex + 1} of {files.length}
                  </span>{" "}
                  · {selectedFile?.name}
                </>
              ) : (
                "No pages loaded"
              )}
            </span>
            <span className="font-mono">
              {cursor ? `x: ${cursor.x}  y: ${cursor.y}` : "x: —  y: —"}
            </span>
            <span className="ml-auto font-medium text-orange">
              ● {drawingTargetName ? `Drawing: ${drawingTargetName}` : "Select a target to draw"}
            </span>
          </div>
        </div>

        <RightPanel
          targets={targets}
          activeTarget={activeTarget}
          setActiveTarget={(t) => {
            setActiveTarget(t);
            setDrawing(true);
          }}
          currentRect={currentRect}
          setCurrentRect={setCurrentRect}
          onStartDrawing={startDrawing}
          onApply={applyCrop}
          settings={settings}
          setSettings={setSettings}
          pageCount={files.length}
          onProcess={process}
          processing={processing}
        />
      </div>

      {toast && (
        <div
          className="fixed right-4 top-[72px] z-50 flex items-center gap-[9px] rounded-md border border-border bg-white px-[14px] py-[10px] text-[13px] font-medium text-text-primary"
          style={{ boxShadow: "var(--shadow-md)" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── toolbar buttons ── */
function ToolbarPrimary({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "h-8 cursor-pointer rounded-sm px-[13px] text-[12.5px] font-medium transition-colors",
        active
          ? "bg-orange text-white hover:bg-orange-hover"
          : "border-[1.5px] border-border-strong bg-white text-text-secondary hover:bg-bg-surface hover:text-text-primary",
      ].join(" ")}
      style={
        active
          ? {
              boxShadow: "0 2px 6px color-mix(in oklab, var(--orange) 30%, transparent)",
            }
          : undefined
      }
    >
      {label}
    </button>
  );
}

function ToolbarSecondary({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-8 cursor-pointer rounded-sm border-[1.5px] border-border-strong bg-white px-[13px] text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function ToolbarGhost({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-8 cursor-pointer rounded-sm bg-transparent px-[13px] text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function ToolbarDestructive({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 cursor-pointer rounded-sm bg-transparent px-[13px] text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-error"
    >
      {label}
    </button>
  );
}

function ZoomControl({ value, onChange }: { value: Zoom; onChange: (z: Zoom) => void }) {
  const options: { v: Zoom; label: string }[] = [
    { v: 0.5, label: "50%" },
    { v: 1, label: "100%" },
    { v: 2, label: "200%" },
    { v: -1, label: "Fit" },
  ];
  return (
    <div className="flex h-[30px] overflow-hidden rounded-sm border-[1.5px] border-border-strong">
      {options.map((o, i) => (
        <button
          key={o.label}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "px-[9px] text-[11.5px] font-medium transition-colors",
            i < options.length - 1 ? "border-r border-border" : "",
            value === o.v
              ? "bg-bg-muted text-text-primary"
              : "bg-white text-text-secondary hover:bg-bg-surface",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  title,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      {...rest}
      className={[
        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm transition-colors",
        active
          ? "bg-navy text-white"
          : "bg-transparent text-text-secondary hover:bg-bg-surface hover:text-text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function CursorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 3l6 16 2-7 7-2L5 3z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 11V5.5a1.5 1.5 0 1 1 3 0V11M10 11V4.5a1.5 1.5 0 1 1 3 0V11M13 11V5.5a1.5 1.5 0 1 1 3 0V13M16 8.5a1.5 1.5 0 1 1 3 0V15a6 6 0 0 1-6 6h-1.5a5 5 0 0 1-4.33-2.5L4 13.5a1.6 1.6 0 0 1 2.65-1.75L8 13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

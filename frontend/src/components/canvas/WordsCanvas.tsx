import { Maximize2, Minus, Plus, Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PageJump } from "@/components/canvas/PageJump";
import { PageRail } from "@/components/canvas/PageRail";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { useZoomToPointer } from "@/hooks/use-zoom-to-pointer";
import type { WordLineStatus } from "@/lib/api";
import {
  holdsWords,
  type BoxGrab,
  type BoxHandle,
  type EditCut,
  type EditLine,
} from "@/lib/words/model";

const PAD = 20;
/** Screen px between stacked strips — constant, not scaled, so the stack stays
 * legible at every zoom. */
const GAP = 26;
/** Status gutter to the left of every strip. */
const GUTTER = 34;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const STEP = 1.4;
/** Screen px of grab band on each edge of a box. Wide enough to hit, narrow enough
 * that the middle of a short word is still draggable as a whole. */
const EDGE_GRAB = 6;

const STATUS_COLOR: Record<WordLineStatus, string> = {
  exact: "var(--success)",
  scored: "var(--warning)",
  partial: "var(--warning)",
  unresolved: "var(--error)",
};

type Column = { x: number; w: number };

type Props = {
  imageUrl: string;
  lines: EditLine[];
  selectedLine: string | null;
  selectedCut: string | null;
  onSelectLine: (lineId: string) => void;
  onSelectCut: (lineId: string, cutUid: string | null) => void;
  /** Double-click inside a word's box splits it there. `x` is page x. */
  onAddCut: (lineId: string, x: number) => void;
  /** Live during a drag — no history entry. */
  onMoveBox: (
    lineId: string,
    cutUid: string,
    handle: BoxHandle,
    x: number,
    grab: BoxGrab | undefined,
  ) => void;
  /** Pointer-up ending a drag. */
  onMoveCommit: () => void;
  onRemoveCut: (lineId: string, cutUid: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  page: number;
  pageCount: number;
  onPageChange: (n: number) => void;
  /** Pages holding any words / complete with nothing flagged — reusing the rail's
   * two indicator slots rather than teaching it a third vocabulary. */
  withWords?: Set<number>;
  clean?: Set<number>;
  isRTL?: boolean;
  /** Toolbar-right content (dirty counter, line position). */
  statusSlot?: ReactNode;
  emptyText?: string;
};

/**
 * The word-boundary editor: every text line of the page as its own strip, cut
 * where each word ends.
 *
 * Each word is a box the height of its line, from `start_x` (its right edge, and the
 * larger number — Arabic runs right to left) to `end_x`. Boxes rather than bare rules
 * because a rule pair with nothing between them is unreadable and unpickable, and
 * because the box *is* the highlight a reader eventually sees.
 *
 * **One coordinate space.** Both edges, `bbox_*` and the served page image are all in
 * page pixels, so a box's screen position is `origin + (x − colX) · scale` — the same
 * expression for every line, which is why boxes on different lines line up with the
 * page column they came from.
 *
 * A whole-page overlay was the other option and is unusable: a line is ~50 px tall
 * at fit with its cuts ~15 px apart, so the real work happens at a zoom where the
 * page is gone anyway. Strips spend that space on the axis carrying the answer.
 */
export function WordsCanvas({
  imageUrl,
  lines,
  selectedLine,
  selectedCut,
  onSelectLine,
  onSelectCut,
  onAddCut,
  onMoveBox,
  onMoveCommit,
  onRemoveCut,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  page,
  pageCount,
  onPageChange,
  withWords,
  clean,
  isRTL,
  statusSlot,
  emptyText,
}: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [box, setBox] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setNatural(null);
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) setNatural({ w: image.naturalWidth, h: image.naturalHeight });
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The page's text column: the union of every line's box. Laying the strips out
  // against it rather than each against itself keeps their right edges — where
  // Arabic starts — in the same place they occupy on the page.
  const column: Column | null = useMemo(() => {
    const drawn = lines.filter((l) => l.bbox.w > 0);
    if (!drawn.length) return null;
    const x = Math.min(...drawn.map((l) => l.bbox.x));
    const right = Math.max(...drawn.map((l) => l.bbox.x + l.bbox.w));
    return { x, w: Math.max(1, right - x) };
  }, [lines]);

  const fit = column && box ? Math.max(0.05, (box - 2 * PAD - GUTTER) / column.w) : 1;
  const scale = fit * zoom;

  useCtrlWheelZoom({ ref: scrollRef, zoom, onZoomChange: setZoom, min: MIN_ZOOM, max: MAX_ZOOM });
  useZoomToPointer({ scrollRef, imgRef: stageRef, scale });

  /** Client x → page x. The inverse of how a cut is positioned below. */
  const toPageX = useCallback(
    (clientX: number): number | null => {
      const stage = stageRef.current;
      if (!stage || !column) return null;
      return column.x + (clientX - stage.getBoundingClientRect().left - PAD - GUTTER) / scale;
    },
    [column, scale],
  );

  /** Listeners live on the window for the length of one drag, attached here
   * rather than in an effect: the drag begins inside an event handler, and an
   * effect would not run until the render that handler causes has committed. */
  const beginDrag = useCallback(
    (line: EditLine, cut: EditCut, handle: BoxHandle, clientX: number) => {
      // Where the pointer took hold, in page x, so a whole-box drag slides with the
      // cursor rather than jumping to centre the box on it.
      const at = toPageX(clientX) ?? cut.start_x;
      const grab: BoxGrab = { start_x: cut.start_x, end_x: cut.end_x, at };
      let moved = false;
      const move = (event: PointerEvent) => {
        const x = toPageX(event.clientX);
        if (x == null) return;
        moved = true;
        onMoveBox(line.line_id, cut.uid, handle, x, grab);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        // Only a real drag is an edit. Without this every click — including each
        // half of a double-click — would push an identical state onto the history.
        if (moved) onMoveCommit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    },
    [toPageX, onMoveBox, onMoveCommit],
  );

  const step = (factor: number) =>
    setZoom((z) => Number(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)).toFixed(3)));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        data-tour="canvas-toolbar"
        className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-border bg-white px-3"
      >
        <IconButton
          label={t("canvas.zoomOut")}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => step(1 / STEP)}
        >
          <Minus size={13} />
        </IconButton>
        <span className="w-11 text-center text-[11px] font-medium tabular-nums text-text-secondary">
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
          disabled={zoom === MIN_ZOOM}
          onClick={() => setZoom(MIN_ZOOM)}
        >
          <Maximize2 size={12} />
        </IconButton>

        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton label={t("words.undo")} disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={13} />
        </IconButton>
        <IconButton label={t("words.redo")} disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={13} />
        </IconButton>

        <div className="ms-auto flex items-center gap-2">
          {statusSlot}
          <PageJump page={page} pageCount={pageCount} onPageChange={onPageChange} />
        </div>
      </div>

      <div ref={scrollRef} className="raqam-canvas-grid flex-1 overflow-auto">
        {!column || !natural ? (
          <div className="flex h-full items-center justify-center text-[12.5px] text-text-muted">
            {emptyText ?? t("words.canvasEmpty")}
          </div>
        ) : (
          // dir=ltr: this is a picture of a page measured in pixels, and pixel x
          // grows rightwards whichever way the script reads. Letting the UI's RTL
          // direction reach in here would mirror the whole stack.
          <div
            ref={stageRef}
            dir="ltr"
            className="relative flex w-max flex-col"
            style={{ minWidth: "100%", padding: PAD, gap: GAP }}
          >
            {lines.map((line) => (
              <Strip
                key={line.line_id}
                line={line}
                column={column}
                scale={scale}
                natural={natural}
                imageUrl={imageUrl}
                selected={line.line_id === selectedLine}
                selectedCut={selectedCut}
                onSelectLine={onSelectLine}
                onSelectCut={onSelectCut}
                onRemoveCut={onRemoveCut}
                onAddCut={(x) => onAddCut(line.line_id, x)}
                onDragStart={(cut, handle, clientX) => beginDrag(line, cut, handle, clientX)}
                toPageX={toPageX}
                removeLabel={t("words.removeCut")}
              />
            ))}
          </div>
        )}
      </div>

      <PageRail
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        processed={withWords}
        reviewed={clean}
        isRTL={isRTL}
      />
    </div>
  );
}

// ── One line ─────────────────────────────────────────────────────────────────

function Strip({
  line,
  column,
  scale,
  natural,
  imageUrl,
  selected,
  selectedCut,
  onSelectLine,
  onSelectCut,
  onRemoveCut,
  onAddCut,
  onDragStart,
  toPageX,
  removeLabel,
}: {
  line: EditLine;
  column: Column;
  scale: number;
  natural: { w: number; h: number };
  imageUrl: string;
  selected: boolean;
  selectedCut: string | null;
  onSelectLine: (lineId: string) => void;
  onSelectCut: (lineId: string, cutUid: string | null) => void;
  onRemoveCut: (lineId: string, cutUid: string) => void;
  onAddCut: (x: number) => void;
  onDragStart: (cut: EditCut, handle: BoxHandle, clientX: number) => void;
  toPageX: (clientX: number) => number | null;
  removeLabel: string;
}) {
  const editable = holdsWords(line);
  const dispW = Math.max(1, line.bbox.w * scale);
  const dispH = Math.max(1, line.bbox.h * scale);
  const dot = line.status ? STATUS_COLOR[line.status] : "var(--text-muted)";

  return (
    <div className="flex items-start" style={{ marginLeft: (line.bbox.x - column.x) * scale }}>
      <div
        className="flex flex-none flex-col items-center justify-center gap-1"
        style={{ width: GUTTER, height: dispH }}
        title={line.reason || undefined}
      >
        <span className="text-[10px] font-semibold tabular-nums text-text-muted">
          {line.line_number}
        </span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
        {line.edited && <span className="h-1 w-3 rounded-full bg-orange" />}
      </div>

      <div
        onPointerDown={() => editable && onSelectLine(line.line_id)}
        onDoubleClick={(e) => {
          if (!editable) return;
          const x = toPageX(e.clientX);
          if (x != null) onAddCut(x);
        }}
        className={`relative flex-none ${editable ? "cursor-crosshair" : "opacity-45"} ${
          selected ? "shadow-[0_0_0_2px_var(--orange)]" : "shadow-[0_0_0_1px_var(--border)]"
        }`}
        style={{
          width: dispW,
          height: dispH,
          backgroundImage: `url("${imageUrl}")`,
          backgroundSize: `${natural.w * scale}px ${natural.h * scale}px`,
          backgroundPosition: `${-line.bbox.x * scale}px ${-line.bbox.y * scale}px`,
          backgroundColor: "white",
          imageRendering: scale > 1.6 ? "pixelated" : undefined,
        }}
      >
        {editable &&
          line.cuts.map((cut, order) => (
            <WordBox
              key={cut.uid}
              cut={cut}
              order={order + 1}
              left={(cut.end_x - line.bbox.x) * scale}
              width={Math.max(1, (cut.start_x - cut.end_x) * scale)}
              height={dispH}
              selected={cut.uid === selectedCut}
              onSelect={() => onSelectCut(line.line_id, cut.uid)}
              onDragStart={(handle, clientX) => onDragStart(cut, handle, clientX)}
              onRemove={() => onRemoveCut(line.line_id, cut.uid)}
              removeLabel={removeLabel}
            />
          ))}
      </div>
    </div>
  );
}

/** One word, drawn as a box over its own ink.
 *
 * Three grab targets: each edge, and the middle. The edges are the boundaries a
 * reviewer corrects; the middle slides a whole word that is the right width but in
 * the wrong place. The fill is deliberately faint — boxes overlap wherever a tail
 * sweeps under a neighbour, and an opaque one would hide the word beneath it.
 */
function WordBox({
  cut,
  order,
  left,
  width,
  height,
  selected,
  onSelect,
  onDragStart,
  onRemove,
  removeLabel,
}: {
  cut: EditCut;
  /** Its place in the line's reading order, from 1. */
  order: number;
  left: number;
  width: number;
  height: number;
  selected: boolean;
  onSelect: () => void;
  onDragStart: (handle: BoxHandle, clientX: number) => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  const color = cut.unlabelled ? "var(--navy)" : "var(--orange)";
  const grab = (handle: BoxHandle) => (event: React.PointerEvent) => {
    event.stopPropagation();
    onSelect();
    onDragStart(handle, event.clientX);
  };
  // Neighbours alternate between two weights of the same tint. Boxes touch, and
  // where a tail runs under the next word they overlap outright — one flat fill
  // would read as a single band across half the line.
  const fill = selected ? 34 : order % 2 ? 9 : 17;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={cut.text || String(cut.word_id ?? "")}
        // No dblclick handler: splitting *is* the double-click, and the strip below
        // does it. This used to stopPropagation, which was right when a word was a
        // 9px rule — you must not split on top of one — but a box covers the whole
        // word, so that swallowed every double-click before the strip saw it.
        className="absolute top-0"
        style={{
          left,
          width,
          height,
          background: `color-mix(in oklab, ${color} ${fill}%, transparent)`,
          // The selected word is lifted rather than merely tinted: a solid rule on
          // each side, a halo separating it from whatever it overlaps, and the top
          // of the stack. Tint alone is not enough to find on a busy line.
          outline: selected
            ? `2px solid ${color}`
            : `1px dashed color-mix(in oklab, ${color} 55%, transparent)`,
          outlineOffset: -1,
          boxShadow: selected
            ? "0 0 0 3px color-mix(in oklab, var(--white) 70%, transparent)"
            : undefined,
          zIndex: selected ? 14 : 10,
        }}
      >
        {/* The middle: slide the whole word. */}
        <div
          onPointerDown={grab("box")}
          className="absolute inset-0 cursor-move"
          style={{ marginLeft: EDGE_GRAB, marginRight: EDGE_GRAB }}
        />
        {/* end_x is the LEFT edge, start_x the right — Arabic runs right to left. */}
        <div
          onPointerDown={grab("end")}
          className="absolute top-0 cursor-ew-resize"
          style={{ left: -EDGE_GRAB / 2, width: EDGE_GRAB, height }}
        />
        <div
          onPointerDown={grab("start")}
          className="absolute top-0 cursor-ew-resize"
          style={{ right: -EDGE_GRAB / 2, width: EDGE_GRAB, height }}
        />
        {/* Grips, on the selected word only — they say which edges are draggable
            without putting furniture on every word of the line. */}
        {selected && (
          <>
            <span
              className="pointer-events-none absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
              style={{ left: -1.5, background: color }}
            />
            <span
              className="pointer-events-none absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full"
              style={{ right: -1.5, background: color }}
            />
          </>
        )}
        {/* Reading order, not left-to-right order. On a well-read line these run
            down in step with the page and go unnoticed; on a badly read one they
            jump about, which is the fastest way to see that the words are out of
            sequence rather than merely misplaced. */}
        <span
          className={`pointer-events-none absolute -top-3.5 right-0 select-none rounded-sm px-[3px] text-[9px] leading-[11px] tabular-nums ${
            selected ? "font-bold text-white" : "font-semibold"
          }`}
          style={selected ? { background: color } : { color }}
        >
          {order}
        </span>
      </div>
      {selected && (
        <button
          type="button"
          title={removeLabel}
          aria-label={removeLabel}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRemove}
          className="absolute z-20 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-white bg-error text-[10px] font-bold leading-none text-white"
          style={{ left: left - 8, top: -8 }}
        >
          ×
        </button>
      )}
    </>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

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
      className={`flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-sm border border-border-strong transition-colors disabled:cursor-default disabled:opacity-40 ${
        active
          ? "border-orange bg-orange text-white"
          : "bg-white text-text-secondary hover:bg-bg-surface"
      }`}
    >
      {children}
    </button>
  );
}

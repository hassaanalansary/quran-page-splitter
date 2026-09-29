import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { mediaUrl } from "@/lib/api";
import {
  decodeLabels,
  doubtOf,
  expectedType,
  highlights,
  isSelected,
  isTyped,
  labelAt,
  labelsInRect,
  needsLook,
  passesFilter,
  selectIds,
  wordCount,
  type BlobFilter,
  type BlobSelection,
  type Doubts,
  type Expectations,
} from "@/lib/calibration/model";
import type { CalibrationLine } from "@/lib/calibration/types";

import { HIGHLIGHT_RGB, ROLE_RGB } from "./colors";
import { subtypeKey } from "./labels";
import { SUBTYPE_MARKS, type Subtype } from "./subtypes";

const SELECTED_RGB: [number, number, number] = [234, 88, 12];
/** Screen px of grab band either side of a word's edge. */
const EDGE_GRAB = 6;
/** A pointer that moves further than this between down and up drew a rectangle. */
const CLICK_SLOP = 4;
/** Screen px each mark's slot in the type lane takes, and each lane row's height. */
const SLOT = 15;
const ROW = 16;

type Raster = { source: ImageBitmap; ids: Uint32Array; width: number; height: number };
type Point = { x: number; y: number };

/**
 * One line of the page as calibration sees it: its own ink, every blob painted by
 * the role it currently has, the words drawn over it.
 *
 * **Why pixels, not boxes.** Handwriting overlaps: a tail sweeps under the next
 * word, a dot sits inside a letter's bowl. Boxes would make those unpickable. The
 * line's label raster says which blob every pixel belongs to, so a click resolves
 * to the blob actually under the pointer and the tint follows the ink exactly.
 *
 * Page pixels throughout, like the word cuts: the raster is the line's own crop of
 * the page at native size, and `scale` is the only conversion.
 */
export function BlobStrip({
  line,
  scale,
  marginLeft,
  label,
  focused = false,
  selection,
  onSelect,
  mode,
  dim,
  disabled,
  selectable = !disabled,
  selectionFilter = "all",
  expectations,
  doubts,
  showTypes = false,
  onWordEdge,
  onWordEdgeCommit,
}: {
  line: CalibrationLine;
  scale: number;
  marginLeft: number;
  label: string;
  /** The line the panel is showing. */
  focused?: boolean;
  selection: BlobSelection;
  onSelect: (selection: BlobSelection) => void;
  /** Blobs: select and label ink. Words: drag word edges. */
  mode: "blobs" | "words";
  /** Fade every blob that is not asking for a look. */
  dim: boolean;
  /** Read-only: a neighbouring page's line, a stale draft, or a preview on show. */
  disabled: boolean;
  /** Blobs can still be picked — to be inspected — on a read-only line of this
   * page. Defaults to `!disabled`. */
  selectable?: boolean;
  /** What a click or a drag may pick; a kind of mark is also shown, the rest faded. */
  selectionFilter?: BlobFilter;
  /** Guessed types for the marks nobody has typed. */
  expectations?: Expectations;
  /** Typed marks the other pages take for another type. */
  doubts?: Doubts;
  /** Label every mark with its type in a lane under the line. */
  showTypes?: boolean;
  /** Live, during a drag — no history entry. */
  onWordEdge?: (index: number, start: number, end: number) => void;
  /** The pointer-up ending a drag. */
  onWordEdgeCommit?: () => void;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [raster, setRaster] = useState<Raster | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [rectangle, setRectangle] = useState<{ from: Point; to: Point } | null>(null);
  const drag = useRef<{ from: Point; client: Point; additive: boolean } | null>(null);

  // Load the line image and its label raster once per snapshot — they never change.
  useEffect(() => {
    if (!line.image_url || !line.labels_url) return;
    const abort = new AbortController();
    let source: ImageBitmap | undefined;
    setRaster(null);
    setError("");
    const bitmap = async (url: string) => {
      const response = await fetch(mediaUrl(url), { credentials: "include", signal: abort.signal });
      if (!response.ok) throw new Error(`${response.status}`);
      // No colour management: the labels are ids, and a converted pixel is a
      // different blob.
      return createImageBitmap(await response.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
    };
    (async () => {
      source = await bitmap(line.image_url!);
      const labels = await bitmap(line.labels_url!);
      try {
        if (labels.width !== source.width || labels.height !== source.height) {
          throw new Error("raster size mismatch");
        }
        const scratch = document.createElement("canvas");
        scratch.width = labels.width;
        scratch.height = labels.height;
        const context = scratch.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no canvas");
        context.drawImage(labels, 0, 0);
        const ids = decodeLabels(context.getImageData(0, 0, labels.width, labels.height).data);
        if (!abort.signal.aborted)
          setRaster({ source, ids, width: source.width, height: source.height });
      } finally {
        labels.close();
      }
    })().catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      abort.abort();
      source?.close();
    };
  }, [line.snapshot_id, line.image_url, line.labels_url, attempt]);

  // Paint: the ink, each blob tinted by its role — or, with a kind of mark chosen,
  // those marks in their own colour and the rest faded; the selection over all.
  const guesses = useMemo(() => expectations ?? new Map(), [expectations]);
  const doubted = useMemo(() => doubts ?? new Map(), [doubts]);
  const shown = useMemo(() => {
    if (!highlights(selectionFilter)) return null;
    return new Set(
      line.blobs
        .filter((blob) => passesFilter(blob, line.snapshot_id, selectionFilter, guesses, doubted))
        .map((blob) => blob.id),
    );
  }, [line.blobs, line.snapshot_id, selectionFilter, guesses, doubted]);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context || !raster) return;
    context.drawImage(raster.source, 0, 0);
    const pixels = context.getImageData(0, 0, raster.width, raster.height);
    const blobs = new Map(line.blobs.map((blob) => [blob.id, blob]));
    const data = pixels.data;
    for (let i = 0; i < raster.ids.length; i++) {
      const id = raster.ids[i];
      if (!id) continue;
      const blob = blobs.get(id);
      if (!blob) continue;
      const chosen = isSelected(selection, line.snapshot_id, id);
      const picked = shown?.has(id) ?? false;
      const faded = !chosen && ((shown !== null && !picked) || (dim && !needsLook(blob)));
      const colour = chosen
        ? SELECTED_RGB
        : faded
          ? ([255, 255, 255] as const)
          : picked
            ? HIGHLIGHT_RGB
            : ROLE_RGB[blob.role];
      const alpha = faded ? 0.8 : chosen || picked ? 0.92 : 0.7;
      const p = i * 4;
      data[p] = Math.round(data[p] * (1 - alpha) + colour[0] * alpha);
      data[p + 1] = Math.round(data[p + 1] * (1 - alpha) + colour[1] * alpha);
      data[p + 2] = Math.round(data[p + 2] * (1 - alpha) + colour[2] * alpha);
      data[p + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [raster, line.blobs, line.snapshot_id, selection, dim, shown]);

  const width = (raster?.width ?? line.bbox.w) * scale;
  const height = (raster?.height ?? line.bbox.h) * scale;

  /** Client coordinates → raster (image) pixels. */
  const toRaster = (event: { clientX: number; clientY: number }, element: Element): Point => {
    const bounds = element.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };

  const canSelect = selectable && mode === "blobs" && raster !== null;

  // One slot per mark, where it sits: its type if a person gave one, else the type
  // it is expected to be, else a dot saying nothing knows yet. Two rows, so marks
  // stacked on one letter — a shadda and its fatha — do not cover each other.
  const lane = useMemo(() => {
    if (!showTypes) return { slots: [], rows: 0 };
    const ends = [-Infinity, -Infinity];
    const slots = line.blobs
      .filter((blob) => blob.role === "mark")
      .map((blob) => {
        const typed = isTyped(blob);
        const guess = typed ? null : expectedType(blob, line.snapshot_id, guesses);
        return {
          blob,
          typed,
          subtype: typed ? blob.subtype : (guess?.subtype ?? ""),
          sure: guess?.sure ?? false,
          doubt: doubtOf(blob, line.snapshot_id, doubted),
          x: (blob.x - line.bbox.x + blob.w / 2) * scale,
        };
      })
      .sort((a, b) => a.x - b.x)
      .map((slot) => {
        const free = ends.findIndex((end) => slot.x - SLOT / 2 >= end);
        const row = free >= 0 ? free : ends[0] <= ends[1] ? 0 : 1;
        ends[row] = slot.x + SLOT / 2;
        return { ...slot, row };
      });
    return { slots, rows: slots.some((slot) => slot.row === 1) ? 2 : slots.length ? 1 : 0 };
  }, [showTypes, guesses, doubted, line.blobs, line.snapshot_id, line.bbox.x, scale]);

  const typeName = (subtype: string) => {
    const key = subtypeKey(subtype);
    return key ? t(key) : subtype;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canSelect || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      from: toRaster(event, event.currentTarget),
      client: { x: event.clientX, y: event.clientY },
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const moved = Math.hypot(
      event.clientX - drag.current.client.x,
      event.clientY - drag.current.client.y,
    );
    if (moved > CLICK_SLOP)
      setRectangle({ from: drag.current.from, to: toRaster(event, event.currentTarget) });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = drag.current;
    drag.current = null;
    setRectangle(null);
    if (!start || !raster) return;
    const to = toRaster(event, event.currentTarget);
    const isRectangle =
      Math.hypot(event.clientX - start.client.x, event.clientY - start.client.y) > CLICK_SLOP;
    const hits = isRectangle
      ? labelsInRect(
          raster.ids,
          raster.width,
          raster.height,
          start.from.x,
          start.from.y,
          to.x,
          to.y,
        )
      : [labelAt(raster.ids, raster.width, raster.height, to.x, to.y)].filter(Boolean);
    // Only text blobs are labelled — an ornament or a symbol is structure — and only
    // the ones the filter lets through.
    const text = new Set(
      line.blobs
        .filter((b) => passesFilter(b, line.snapshot_id, selectionFilter, guesses, doubted))
        .map((b) => b.id),
    );
    const chosen = hits.filter((id) => text.has(id));
    const current = selection.snapshot === line.snapshot_id ? selection.ids : [];
    onSelect({
      snapshot: line.snapshot_id,
      ids: selectIds(current, chosen, start.additive, !isRectangle),
    });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /** Drag one edge of a word; listeners on the window for the length of the drag. */
  const beginEdgeDrag = (index: number, handle: "start" | "end", event: ReactPointerEvent) => {
    if (disabled || mode !== "words" || !onWordEdge) return;
    event.stopPropagation();
    event.preventDefault();
    const word = line.words[index];
    const strip = (event.currentTarget as HTMLElement).closest("[data-strip]");
    if (!strip) return;
    let moved = false;
    const move = (e: PointerEvent) => {
      const x = line.bbox.x + (e.clientX - strip.getBoundingClientRect().left) / scale;
      moved = true;
      if (handle === "start") onWordEdge(index, x, word.end_x);
      else onWordEdge(index, word.start_x, x);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (moved) onWordEdgeCommit?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className="flex flex-col" style={{ marginLeft }} data-line={line.snapshot_id}>
      <div className="flex items-center gap-2 text-[10.5px] text-text-muted">
        <span className={`font-semibold tabular-nums ${focused ? "text-orange" : ""}`}>
          {label}
        </span>
        {line.readonly && (
          <span className="rounded-sm bg-bg-surface px-1.5 py-px">
            {line.approved ? t("calibration.contextConfirmed") : t("calibration.context")}
          </span>
        )}
        {line.status && line.status !== "exact" && !line.readonly && (
          <span className="text-warning" title={line.reason ?? undefined}>
            {t(`words.status_${line.status}`)}
          </span>
        )}
      </div>

      {/* One count per word — the PAWs its ink gives it against what its spelling
          needs — over the word's right edge, where it starts. A lane of its own,
          so a count never covers ink or the line's label. */}
      <div className="relative h-4 flex-none" style={{ width }}>
        {line.words.map((word, index) => {
          const count = wordCount(line, word);
          return (
            <span
              key={`${word.word_id ?? "u"}-${index}`}
              className={`absolute bottom-0.5 -translate-x-full select-none whitespace-nowrap rounded-sm px-[3px] text-[9px] font-semibold leading-[11px] tabular-nums ${
                count.ok ? "text-orange" : "bg-warning text-white"
              }`}
              style={{ left: (word.start_x - line.bbox.x) * scale }}
              title={word.text}
            >
              {word.word_id === null ? "∅" : `${count.got}/${count.want}`}
              {word.override ? " ✎" : ""}
            </span>
          );
        })}
      </div>

      <div
        data-strip
        className={`relative bg-white shadow-[0_0_0_1px_var(--border)] ${line.readonly ? "opacity-60" : ""}`}
        style={{ width, height }}
      >
        <canvas
          ref={canvas}
          width={raster?.width ?? 1}
          height={raster?.height ?? 1}
          aria-label={label}
          className={`block ${canSelect ? "cursor-crosshair" : ""}`}
          style={{
            width,
            height,
            touchAction: "none",
            visibility: raster ? "visible" : "hidden",
            imageRendering: scale > 1.6 ? "pixelated" : undefined,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setRectangle(null);
          }}
        />

        {/* Words: a thin outline from where each starts to where it ends — solid
            once dragged by hand. Draggable edges in Words mode; in Blobs mode they
            stay out of the pointer's way. */}
        {line.words.map((word, index) => (
          <div
            key={`${word.word_id ?? "u"}-${index}`}
            className="pointer-events-none absolute top-0"
            style={{
              left: (word.end_x - line.bbox.x) * scale,
              width: Math.max(1, (word.start_x - word.end_x) * scale),
              height,
              outline: `1px ${word.override ? "solid" : "dashed"} color-mix(in oklab, var(--orange) 70%, transparent)`,
              outlineOffset: -1,
            }}
          >
            {mode === "words" && !disabled && (
              <>
                <div
                  className="pointer-events-auto absolute top-0 cursor-ew-resize"
                  style={{ left: -EDGE_GRAB / 2, width: EDGE_GRAB, height }}
                  onPointerDown={(event) => beginEdgeDrag(index, "end", event)}
                />
                <div
                  className="pointer-events-auto absolute top-0 cursor-ew-resize"
                  style={{ right: -EDGE_GRAB / 2, width: EDGE_GRAB, height }}
                  onPointerDown={(event) => beginEdgeDrag(index, "start", event)}
                />
              </>
            )}
          </div>
        ))}

        {/* A dot over every blob asking for a look — findable at any zoom. */}
        {mode === "blobs" &&
          line.blobs
            .filter((blob) => isSelected(selection, line.snapshot_id, blob.id))
            .map((blob) => (
              <span
                key={`selected-${blob.id}`}
                data-blob-outline={`${line.snapshot_id}:${blob.id}`}
                className="pointer-events-none absolute border-2 border-black"
                style={{
                  left: (blob.x - line.bbox.x) * scale - 2,
                  top: (blob.y - line.bbox.y) * scale - 2,
                  width: blob.w * scale + 4,
                  height: blob.h * scale + 4,
                  borderStyle: blob.role === "mark" ? "dashed" : "solid",
                }}
              />
            ))}
        {!line.readonly &&
          line.blobs.filter(needsLook).map((blob) => (
            <span
              key={`look-${blob.id}`}
              className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-orange shadow-[0_0_0_1.5px_var(--white)]"
              style={{
                left: (blob.x - line.bbox.x + blob.w / 2) * scale,
                top: Math.max(0, (blob.y - line.bbox.y) * scale - 6),
              }}
              data-blob={`${line.snapshot_id}:${blob.id}`}
            />
          ))}

        {rectangle && (
          <div
            className="pointer-events-none absolute bg-[color:color-mix(in_oklab,var(--info)_14%,transparent)] outline outline-1 outline-[color:var(--info)]"
            style={{
              left: Math.min(rectangle.from.x, rectangle.to.x) * scale,
              top: Math.min(rectangle.from.y, rectangle.to.y) * scale,
              width: Math.abs(rectangle.from.x - rectangle.to.x) * scale,
              height: Math.abs(rectangle.from.y - rectangle.to.y) * scale,
            }}
          />
        )}

        {!raster && (
          <div
            className="absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-text-muted"
            role={error ? "alert" : "status"}
          >
            {error ? (
              <>
                <span>{t("calibration.maskError", { error })}</span>
                <button
                  type="button"
                  className="cursor-pointer underline"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  {t("calibration.retry")}
                </button>
              </>
            ) : (
              t("calibration.loadingLine")
            )}
          </div>
        )}
      </div>

      {lane.rows > 0 && (
        <div className="relative flex-none" style={{ width, height: lane.rows * ROW + 2 }}>
          {lane.slots.map(({ blob, typed, subtype, sure, doubt, x, row }) => {
            const chosen = isSelected(selection, line.snapshot_id, blob.id);
            const outside = shown !== null && !shown.has(blob.id);
            const title = doubt
              ? t("calibration.types.doubtTitle", {
                  type: typeName(subtype),
                  other: typeName(doubt.subtype),
                })
              : !subtype
                ? t("calibration.types.untyped")
                : typed
                  ? t("calibration.types.typedTitle", { type: typeName(subtype) })
                  : t(sure ? "calibration.types.sureTitle" : "calibration.types.likelyTitle", {
                      type: typeName(subtype),
                    });
            return (
              <button
                key={blob.id}
                type="button"
                dir="rtl"
                title={title}
                aria-label={title}
                disabled={!canSelect}
                onClick={(event) => {
                  const additive = event.shiftKey || event.ctrlKey || event.metaKey;
                  const current = selection.snapshot === line.snapshot_id ? selection.ids : [];
                  onSelect({
                    snapshot: line.snapshot_id,
                    ids: selectIds(current, [blob.id], additive, additive),
                  });
                }}
                className={`absolute flex -translate-x-1/2 items-center justify-center rounded-sm text-[13px] leading-none disabled:cursor-default ${
                  chosen
                    ? "bg-orange text-white"
                    : typed
                      ? "font-semibold"
                      : subtype
                        ? "border border-dashed border-border-strong bg-white text-text-secondary"
                        : "text-text-muted"
                } ${doubt && !chosen ? "outline outline-2 outline-warning" : ""} ${canSelect ? "cursor-pointer" : ""}`}
                style={{
                  left: x,
                  top: row * ROW + 1,
                  width: SLOT - 1,
                  height: ROW - 2,
                  opacity: outside ? 0.2 : !subtype ? 0.45 : typed || sure || chosen ? 1 : 0.6,
                  // A typed mark reads in the colour marks are painted in.
                  color: typed && !chosen ? `rgb(${ROLE_RGB.mark.join(",")})` : undefined,
                }}
              >
                {subtype ? (SUBTYPE_MARKS[subtype as Subtype] ?? "?") : "·"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { BusyLabel } from "@/components/app/SatrLoader";
import { mediaUrl } from "@/lib/api";
import {
  decodeLabels,
  doubtOf,
  expectationKey,
  expectedType,
  highlights,
  isFusedBody,
  isSelected,
  isTyped,
  labelAt,
  labelsInRect,
  markCheckOf,
  needsLook,
  noiseFor,
  passesFilter,
  selectIds,
  subtypeParts,
  typedByText,
  wordCount,
  type BlobFilter,
  type BlobSelection,
  type Doubts,
  type Expectations,
  type MarkChecks,
  type NoiseSuspects,
} from "@/lib/calibration/model";
import type { CalibrationLine } from "@/lib/calibration/types";

import { HIGHLIGHT_RGB, ROLE_RGB, UNSETTLED_RGB } from "./colors";
import { exceptionKey, useTypeName } from "./labels";
import { TANWEEN_MARKS, subtypeGlyph } from "./subtypes";

const SELECTED_RGB: [number, number, number] = [234, 88, 12];
/** Erased ink is hatched in this, over white: still there to pick, plainly not text. */
const ERASED_RGB: [number, number, number] = [201, 42, 42];
/** Screen px the ring around a mark that may be noise is at the least — a speck is a
 * pixel or two. A flagged blob's frame is at least as big, for the same reason. */
const NOISE_RING = 14;
/** Screen px the ring around a mark whose type is not settled is at the least. */
const UNSETTLED_RING = 18;
/** The overlay language's warn, as a wash: a word whose PAWs do not close. */
const WARN_WASH = "rgba(154, 91, 0, 0.12)";
/** A pointer that moves further than this between down and up drew a rectangle. */
const CLICK_SLOP = 4;
/** Screen px each mark's slot in the type lane takes, and each lane row's height. */
const SLOT = 15;
const ROW = 17;
/** Screen px of page around the ink, inside the line's box. */
const INSET = 12;
/** Screen px of the line-number gutter beside the box, and of the gap before it. */
const GUTTER = 34;
const GUTTER_GAP = 10;
/** Screen px a strip adds to the width of its text column: the box's inset on both
 * sides and the number gutter. What Fit leaves room for. */
export const STRIP_CHROME = INSET * 2 + GUTTER_GAP + GUTTER;

type Raster = { source: ImageBitmap; ids: Uint32Array; width: number; height: number };
type FlagKind = "mixed" | "broken" | "fused" | "uncertain";
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
 * Page pixels throughout: the raster is the line's own crop of the page at native
 * size, and `scale` is the only conversion.
 *
 * The line sits in a white box as wide as the page's text column, its number in a
 * gutter at the end, so every line's box and number line up. The colours inside
 * are the overlay language's and fixed: a page stays light in dark mode.
 */
export function BlobStrip({
  line,
  scale,
  marginLeft,
  columnWidth,
  label,
  focused = false,
  selection,
  onSelect,
  dim,
  disabled,
  selectable = !disabled,
  selectionFilter = "all",
  pickAll = false,
  movedWords,
  expectations,
  doubts,
  tanween,
  noise,
  checks,
  showTypes = false,
}: {
  line: CalibrationLine;
  scale: number;
  marginLeft: number;
  /** Screen px of the page's text column: the box's width, whatever the line's. */
  columnWidth?: number;
  label: string;
  /** The line the panel is showing. */
  focused?: boolean;
  selection: BlobSelection;
  onSelect: (selection: BlobSelection) => void;
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
  /** Strokes of a tanween, by `snapshot:blob`: shown as the tanween they make. */
  tanween?: Set<string>;
  /** Marks that may be noise: ringed, to be found and erased or not. */
  noise?: NoiseSuspects;
  /** Every word's marks against its text's: a word they do not fit is outlined. */
  checks?: MarkChecks;
  /** Let a click or a drag pick the faded ink too — to fix a mark the filter missed. */
  pickAll?: boolean;
  /** The words a preview's reading moved, by id: outlined so they are looked at. */
  movedWords?: Set<number>;
  /** Label every mark with its type in a lane under the line. */
  showTypes?: boolean;
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
  // Marks whose type is not settled: no type and no sure guess, or a type the other
  // pages doubt. With the types shown, their ink is painted to stand out, and ringed.
  const unsettled = useMemo(() => {
    if (!showTypes || line.readonly) return new Set<number>();
    return new Set(
      line.blobs
        .filter(
          (blob) =>
            blob.role === "mark" &&
            !blob.erased &&
            (!!doubtOf(blob, line.snapshot_id, doubted) ||
              (!isTyped(blob) && !expectedType(blob, line.snapshot_id, guesses)?.sure)),
        )
        .map((blob) => blob.id),
    );
  }, [showTypes, line.readonly, line.blobs, line.snapshot_id, guesses, doubted]);
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
      const p = i * 4;
      if (blob.erased) {
        // Diagonal stripes, so erased ink reads as struck out at any zoom.
        const stripe = (((i % raster.width) + Math.floor(i / raster.width)) >> 2) % 2 === 0;
        const colour = chosen ? SELECTED_RGB : stripe ? ERASED_RGB : ([255, 255, 255] as const);
        const alpha = stripe ? 0.6 : 0.85;
        data[p] = Math.round(data[p] * (1 - alpha) + colour[0] * alpha);
        data[p + 1] = Math.round(data[p + 1] * (1 - alpha) + colour[1] * alpha);
        data[p + 2] = Math.round(data[p + 2] * (1 - alpha) + colour[2] * alpha);
        data[p + 3] = 255;
        continue;
      }
      const picked = shown?.has(id) ?? false;
      const faded = !chosen && ((shown !== null && !picked) || (dim && !needsLook(blob)));
      const colour = chosen
        ? SELECTED_RGB
        : faded
          ? ([255, 255, 255] as const)
          : picked
            ? HIGHLIGHT_RGB
            : unsettled.has(id)
              ? UNSETTLED_RGB
              : ROLE_RGB[blob.role];
      const alpha = faded ? 0.8 : chosen || picked || unsettled.has(id) ? 0.92 : 0.7;
      data[p] = Math.round(data[p] * (1 - alpha) + colour[0] * alpha);
      data[p + 1] = Math.round(data[p + 1] * (1 - alpha) + colour[1] * alpha);
      data[p + 2] = Math.round(data[p + 2] * (1 - alpha) + colour[2] * alpha);
      data[p + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [raster, line.blobs, line.snapshot_id, selection, dim, shown, unsettled]);

  const selectedWords = useMemo(() => {
    if (selection.snapshot !== line.snapshot_id) return new Set<number>();
    const chosen = new Set(selection.ids);
    return new Set(
      line.blobs
        .filter((blob) => chosen.has(blob.id))
        .flatMap((blob) => blob.allocations.map((allocation) => allocation.word_id)),
    );
  }, [selection, line.snapshot_id, line.blobs]);

  const width = (raster?.width ?? line.bbox.w) * scale;
  const height = (raster?.height ?? line.bbox.h) * scale;

  /** Client coordinates → raster (image) pixels. */
  const toRaster = (event: { clientX: number; clientY: number }, element: Element): Point => {
    const bounds = element.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };

  const canSelect = selectable && raster !== null;

  // One slot per mark, where it sits: its type if a person gave one, else the type
  // it is expected to be, else a dot saying nothing knows yet. Two rows, so marks
  // stacked on one letter — a shadda and its fatha — do not cover each other.
  const lane = useMemo(() => {
    if (!showTypes) return { slots: [], rows: 0 };
    const ends = [-Infinity, -Infinity];
    const slots = line.blobs
      .filter((blob) => blob.role === "mark" && !blob.erased)
      .map((blob) => {
        const typed = isTyped(blob);
        const guess = typed ? null : expectedType(blob, line.snapshot_id, guesses);
        return {
          blob,
          typed,
          byText: typedByText(blob),
          stroke: tanween?.has(expectationKey(line.snapshot_id, blob.id)) ?? false,
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
  }, [showTypes, guesses, doubted, tanween, line.blobs, line.snapshot_id, line.bbox.x, scale]);

  const typeName = useTypeName();

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
    // the ones the filter lets through, unless the faded ones may be picked too.
    const text = new Set(
      line.blobs
        .filter((b) =>
          passesFilter(b, line.snapshot_id, pickAll ? "all" : selectionFilter, guesses, doubted),
        )
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

  const boxWidth = Math.max(columnWidth ?? 0, marginLeft + width) + INSET * 2;

  return (
    <div className="flex items-stretch" style={{ gap: GUTTER_GAP }} data-line={line.snapshot_id}>
      <div
        className={`flex flex-col bg-white py-2 ${line.readonly ? "opacity-60" : ""}`}
        style={{
          width: boxWidth,
          paddingInline: INSET,
          boxShadow: focused ? "0 0 0 2px var(--lapis)" : "0 0 0 1px var(--rule)",
        }}
      >
        <div className="flex flex-col" style={{ marginLeft }}>
          {(line.readonly || (line.status && line.status !== "exact")) && (
            <div className="flex items-center gap-2 pb-1 text-[10.5px]">
              {line.readonly && (
                <span
                  className="rounded-sm px-1.5 py-px"
                  style={{ background: "#efe8dc", color: "var(--ov-text-quiet)" }}
                >
                  {line.approved ? t("calibration.contextConfirmed") : t("calibration.context")}
                </span>
              )}
              {line.status && line.status !== "exact" && !line.readonly && (
                <span style={{ color: "var(--ov-warn)" }} title={line.reason ?? undefined}>
                  {t(`words.status_${line.status}`)}
                </span>
              )}
            </div>
          )}

          {/* One count per word — the PAWs its ink gives it against what its spelling
              needs — over the word's right edge, where it starts. A lane of its own,
              so a count never covers ink. */}
          <div className="relative h-[18px] flex-none" style={{ width }}>
            {line.words.map((word, index) => {
              const count = wordCount(line, word);
              return (
                <span
                  key={`${word.word_id ?? "u"}-${index}`}
                  className="absolute bottom-[3px] -translate-x-full select-none whitespace-nowrap rounded-[3px] px-1 font-mono text-[10px] font-semibold leading-[13px]"
                  style={{
                    left: (word.start_x - line.bbox.x) * scale,
                    background: count.ok ? undefined : "var(--ov-warn)",
                    color: count.ok ? "var(--ov-text-quiet)" : "#ffffff",
                  }}
                  title={word.text}
                >
                  {word.word_id === null ? "∅" : `${count.got}/${count.want}`}
                </span>
              );
            })}
          </div>

          <div data-strip className="relative bg-white" style={{ width, height }}>
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

            {/* Words: a thin dashed outline from where each starts to where it ends —
            the extent of its ink — out of the pointer's way. The word the selection
            is in is solid; a word a preview moved is lapis. */}
            {line.words.map((word, index) => {
              const moved = word.word_id !== null && !!movedWords?.has(word.word_id);
              const chosen = word.word_id !== null && selectedWords.has(word.word_id);
              // What a confirmation asks about, seen from across the page: a word whose
              // PAWs do not close is outlined solid in warn and washed; one whose marks
              // do not fit its text, dashed.
              const short = !line.readonly && word.word_id !== null && !wordCount(line, word).ok;
              const check =
                !line.readonly && word.word_id !== null && checks
                  ? markCheckOf(line.snapshot_id, word.word_id, checks)
                  : null;
              const unfit = !!check && !check.ok;
              return (
                <div
                  key={`${word.word_id ?? "u"}-${index}`}
                  data-word={`${line.snapshot_id}:${index}`}
                  className="pointer-events-none absolute top-0 rounded-[2px]"
                  style={{
                    left: (word.end_x - line.bbox.x) * scale,
                    width: Math.max(1, (word.start_x - word.end_x) * scale),
                    height,
                    outline: moved
                      ? "2px solid var(--ov-line-selected)"
                      : short
                        ? "2px solid var(--ov-warn)"
                        : chosen
                          ? "1.5px solid var(--ov-word)"
                          : unfit
                            ? "1.5px dashed var(--ov-warn)"
                            : "1px dashed color-mix(in oklab, var(--ov-word) 70%, transparent)",
                    background: moved ? "rgba(30, 78, 140, 0.12)" : short ? WARN_WASH : undefined,
                    outlineOffset: -1,
                  }}
                />
              );
            })}

            {/* A dot over every blob asking for a look — findable at any zoom. */}
            {line.blobs
              .filter((blob) => isSelected(selection, line.snapshot_id, blob.id))
              .map((blob) => (
                <span
                  key={`selected-${blob.id}`}
                  data-blob-outline={`${line.snapshot_id}:${blob.id}`}
                  className={`pointer-events-none absolute border-2 ${
                    blob.role === "mark" ? "rounded-full border-dashed" : "rounded-[3px]"
                  }`}
                  style={{
                    left: (blob.x - line.bbox.x) * scale - 3,
                    top: (blob.y - line.bbox.y) * scale - 3,
                    width: blob.w * scale + 6,
                    height: blob.h * scale + 6,
                    borderColor: "var(--ov-selected)",
                  }}
                />
              ))}
            {!line.readonly &&
              line.blobs.filter(needsLook).map((blob) => (
                <span
                  key={`look-${blob.id}`}
                  className="pointer-events-none absolute h-[9px] w-[9px] -translate-x-1/2 rounded-full shadow-[0_0_0_2px_#ffffff]"
                  style={{
                    background: "var(--ov-line-selected)",
                    left: (blob.x - line.bbox.x + blob.w / 2) * scale,
                    top: Math.max(0, (blob.y - line.bbox.y) * scale - 10),
                  }}
                  data-blob={`${line.snapshot_id}:${blob.id}`}
                />
              ))}

            {/* Marks whose type is not settled, ringed in their own colour. */}
            {line.blobs
              .filter((blob) => unsettled.has(blob.id))
              .map((blob) => {
                const size = Math.max(UNSETTLED_RING, Math.max(blob.w, blob.h) * scale + 10);
                return (
                  <span
                    key={`unsettled-${blob.id}`}
                    className="pointer-events-none absolute rounded-full border-2"
                    style={{
                      borderColor: `rgb(${UNSETTLED_RGB.join(",")})`,
                      left: (blob.x - line.bbox.x + blob.w / 2) * scale - size / 2,
                      top: (blob.y - line.bbox.y + blob.h / 2) * scale - size / 2,
                      width: size,
                      height: size,
                    }}
                  />
                );
              })}

            {/* Ink you flagged as out of the ordinary: framed solid in warn, with its
                flag on the frame — at least a ring's size, so a speck still shows. */}
            {!line.readonly &&
              line.blobs
                .filter((blob) => blob.exception && !blob.erased)
                .map((blob) => {
                  const width = Math.max(NOISE_RING, blob.w * scale + 8);
                  const height = Math.max(NOISE_RING, blob.h * scale + 8);
                  const key = exceptionKey(blob.exception);
                  return (
                    <span
                      key={`flag-${blob.id}`}
                      className="pointer-events-none absolute rounded-[3px] border-2 shadow-[0_0_0_1px_#ffffff]"
                      style={{
                        borderColor: "var(--ov-warn)",
                        left: (blob.x - line.bbox.x + blob.w / 2) * scale - width / 2,
                        top: (blob.y - line.bbox.y + blob.h / 2) * scale - height / 2,
                        width,
                        height,
                      }}
                    >
                      <span
                        className="absolute -top-[9px] start-[-2px] whitespace-nowrap rounded-[3px] px-1 text-[9.5px] font-bold leading-[13px] text-white"
                        style={{ background: "var(--ov-warn)" }}
                      >
                        ⚑ {key ? t(`calibration.flagShort.${blob.exception as FlagKind}`) : ""}
                        {isFusedBody(blob) && blob.subtype && (
                          <span dir="rtl" className="ms-1 font-quran text-[12px]">
                            {subtypeParts(blob.subtype).map(subtypeGlyph).join(" ")}
                          </span>
                        )}
                      </span>
                    </span>
                  );
                })}

            {!line.readonly &&
              noise &&
              line.blobs
                .filter((blob) => noiseFor(blob, line.snapshot_id, noise))
                .map((blob) => {
                  const width = Math.max(NOISE_RING, blob.w * scale + 8);
                  const height = Math.max(NOISE_RING, blob.h * scale + 8);
                  return (
                    <span
                      key={`noise-${blob.id}`}
                      className="pointer-events-none absolute rounded-full border-[1.5px] border-dashed"
                      style={{
                        borderColor: "var(--ov-warn)",
                        left: (blob.x - line.bbox.x + blob.w / 2) * scale - width / 2,
                        top: (blob.y - line.bbox.y + blob.h / 2) * scale - height / 2,
                        width,
                        height,
                      }}
                    />
                  );
                })}

            {rectangle && (
              <div
                className="pointer-events-none absolute bg-[rgba(30,78,140,0.14)] outline outline-1 outline-[color:var(--ov-line-selected)]"
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
                className="absolute inset-0 flex items-center justify-center gap-2 text-[11px]"
                style={{ color: "var(--ov-text-quiet)" }}
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
                  <BusyLabel>{t("calibration.loadingLine")}</BusyLabel>
                )}
              </div>
            )}
          </div>

          {lane.rows > 0 && (
            <div className="relative mt-1 flex-none" style={{ width, height: lane.rows * ROW + 2 }}>
              {lane.slots.map(({ blob, typed, byText, stroke, subtype, sure, doubt, x, row }) => {
                const chosen = isSelected(selection, line.snapshot_id, blob.id);
                const outside = shown !== null && !shown.has(blob.id);
                const named = doubt
                  ? t("calibration.types.doubtTitle", {
                      type: typeName(subtype),
                      other: typeName(doubt.subtype),
                    })
                  : !subtype
                    ? t("calibration.types.untyped")
                    : typed
                      ? t(byText ? "calibration.types.textTitle" : "calibration.types.typedTitle", {
                          type: typeName(subtype),
                        })
                      : t(sure ? "calibration.types.sureTitle" : "calibration.types.likelyTitle", {
                          type: typeName(subtype),
                        });
                const title = stroke ? `${named} · ${t("calibration.types.tanweenStroke")}` : named;
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
                    className={`absolute flex -translate-x-1/2 items-center justify-center rounded-[4px] text-[13px] leading-none disabled:cursor-default ${
                      typed ? "font-semibold" : ""
                    } ${canSelect ? "cursor-pointer" : ""}`}
                    style={{
                      left: x,
                      top: row * ROW + 1,
                      width: SLOT - 1,
                      height: ROW - 2,
                      opacity: outside ? 0.2 : !subtype ? 0.45 : typed || sure || chosen ? 1 : 0.6,
                      // Typed: solid, in the colour marks are painted in. Expected: dashed.
                      // The selection is gold; a doubted type is ringed in warn.
                      border: chosen
                        ? "1px solid var(--ov-selected)"
                        : typed
                          ? "1px solid rgba(40, 180, 200, 0.6)"
                          : subtype
                            ? "1px dashed var(--ov-mark)"
                            : undefined,
                      background: chosen
                        ? "rgba(201, 150, 46, 0.25)"
                        : typed
                          ? "rgba(40, 180, 200, 0.12)"
                          : undefined,
                      color: typed
                        ? "var(--satr-mark)"
                        : subtype
                          ? "var(--ov-text)"
                          : "var(--ov-text-quiet)",
                      outline: doubt && !chosen ? "2px solid var(--ov-warn)" : undefined,
                    }}
                  >
                    {subtype
                      ? stroke
                        ? (TANWEEN_MARKS[subtype] ?? subtypeGlyph(subtype))
                        : subtypeGlyph(subtype)
                      : "·"}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* The line's number, in the gutter at the end. */}
      <div
        className={`flex flex-none flex-col items-center justify-center gap-0.5 rounded border font-mono ${
          focused
            ? "border-lapis/40 bg-lapis-wash text-lapis-text"
            : "border-rule bg-card text-ink-3"
        }`}
        style={{ width: GUTTER }}
        title={label}
      >
        {line.readonly && (
          <span className="text-[9.5px] leading-none">
            {t("calibration.gutterPage", { page: line.page_number })}
          </span>
        )}
        <span className="text-[11.5px] font-semibold">{line.line_number}</span>
      </div>
    </div>
  );
}

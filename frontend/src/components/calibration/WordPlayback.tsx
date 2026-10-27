import {
  ArrowLeftRight,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Pause,
  Pencil,
  Play,
  Repeat,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { BusyLabel } from "@/components/app/SatrLoader";
import { useCtrlWheelZoom } from "@/hooks/use-ctrl-wheel-zoom";
import { mediaUrl } from "@/lib/api";
import {
  decodeLabels,
  expectedType,
  isTyped,
  wordCount,
  wordRisks,
  type BlobSelection,
  type Expectations,
  type MarkChecks,
} from "@/lib/calibration/model";
import {
  MARK_INK,
  TYPE_INK,
  belongsAt,
  inkColor,
  playbackWords,
  wordBlobs,
  wordCrop,
} from "@/lib/calibration/playback";
import type { CalibrationLine } from "@/lib/calibration/types";
import { revealInScroller } from "@/lib/reveal";

import { useTypeName } from "./labels";
import { subtypeGlyph } from "./subtypes";

const SPEEDS = { slow: 2400, normal: 1300, fast: 650 } as const;
type Speed = keyof typeof SPEEDS;

/** Screen px between the well's edge and the sheet, and of white around the ink. */
const PAD = 20;
const SHEET = 28;
/** The other words' ink: near-black, so the current word's black body still reads
 * as the one being played. */
const INK: readonly [number, number, number] = [52, 52, 52];
/** The fade slider: 0 shows the other words, 50 dims them to this, 100 hides them. */
const DIMMED = 0.2;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

type Raster = { ids: Uint32Array; width: number; height: number };
type Rasters = { lines: Map<string, Raster>; failed: Set<string>; settled: boolean };

/** How visible the other words are, from the fade slider's position. */
function othersOpacity(fade: number) {
  return fade <= 50 ? 1 - (fade / 50) * (1 - DIMMED) : DIMMED * (1 - (fade - 50) / 50);
}

/**
 * The page played word by word, in place of the editor's canvas: every guide the
 * editing needs is put away, and the page is drawn as it is printed — its lines at
 * their own places on one white sheet. Two layers:
 *
 *     the other words  ── one ink colour, faded by the slider: shown → dimmed → hidden
 *     the current word ── its body black, each mark in its type's colour, on a gold wash
 *
 * The view follows the current word. Fit width or fit height; Ctrl + wheel zooms.
 * Read-only: "Edit this word" goes back to the editor with its ink selected.
 */
export function WordPlayer({
  page,
  lines,
  expectations,
  checks,
  preview,
  onExit,
  onInspect,
}: {
  page: number;
  lines: CalibrationLine[];
  expectations: Expectations;
  /** Every word's marks against its text's: a word they do not fit is worth a look. */
  checks?: MarkChecks;
  /** The lines are a preview's re-reading, not the draft. */
  preview: boolean;
  onExit: () => void;
  /** Back to editing, with this ink selected. */
  onInspect: (selection: BlobSelection) => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();

  const own = useMemo(() => lines.filter((line) => !line.readonly), [lines]);
  const all = useMemo(() => playbackWords(own), [own]);
  const risky = useMemo(
    () => all.filter((entry) => wordRisks(entry.line, entry.word, checks).length > 0),
    [all, checks],
  );
  const [riskyFirst, setRiskyFirst] = useState(false);
  const entries = useMemo(
    () => (riskyFirst ? [...risky, ...all.filter((entry) => !risky.includes(entry))] : all),
    [all, risky, riskyFirst],
  );

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [speed, setSpeed] = useState<Speed>("normal");
  const [repeat, setRepeat] = useState(false);
  const [byType, setByType] = useState(true);
  const [fade, setFade] = useState(50);
  const [fit, setFit] = useState<"width" | "height">("width");
  const [zoom, setZoom] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [full, setFull] = useState(false);
  const [room, setRoom] = useState({ w: 0, h: 0 });

  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const top = useRef<HTMLCanvasElement>(null);
  const wash = useRef<HTMLDivElement>(null);

  const rasters = useRasters(own, attempt);
  const safeIndex = Math.min(index, Math.max(0, entries.length - 1));
  const current = entries[safeIndex];

  // The printed block the lines fill: what the sheet holds, in page px.
  const block = useMemo(() => {
    const drawn = own.filter((line) => line.bbox.w > 0 && line.bbox.h > 0);
    if (!drawn.length) return null;
    const x = Math.min(...drawn.map((line) => line.bbox.x));
    const y = Math.min(...drawn.map((line) => line.bbox.y));
    const right = Math.max(...drawn.map((line) => line.bbox.x + line.bbox.w));
    const bottom = Math.max(...drawn.map((line) => line.bbox.y + line.bbox.h));
    return { x, y, w: right - x, h: bottom - y };
  }, [own]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setRoom({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useCtrlWheelZoom({ ref: scroller, zoom, onZoomChange: setZoom, min: MIN_ZOOM, max: MAX_ZOOM });

  const fitWidth = block && room.w ? (room.w - 2 * PAD - 2 * SHEET) / block.w : 1;
  const fitHeight = block && room.h ? (room.h - 2 * PAD - 2 * SHEET) / block.h : 1;
  const scale = Math.max(0.02, (fit === "width" ? fitWidth : fitHeight) * zoom);

  // The current word's marks, typed or expected: what colours them.
  const types = useMemo(() => {
    const found = new Map<number, string>();
    if (!current) return found;
    for (const blob of wordBlobs(current)) {
      if (blob.role !== "mark") continue;
      found.set(
        blob.id,
        isTyped(blob)
          ? blob.subtype
          : (expectedType(blob, current.line.snapshot_id, expectations)?.subtype ?? ""),
      );
    }
    return found;
  }, [current, expectations]);

  // The other words: every line's ink in one colour, painted once.
  useEffect(() => {
    const context = base.current?.getContext("2d");
    if (!context || !block) return;
    context.clearRect(0, 0, block.w, block.h);
    for (const line of own) {
      const raster = rasters.lines.get(line.snapshot_id);
      if (!raster) continue;
      const blobs = new Map(line.blobs.map((blob) => [blob.id, blob]));
      paint(context, raster, line.bbox.x - block.x, line.bbox.y - block.y, (id) => {
        const blob = blobs.get(id);
        return blob && !blob.erased ? INK : null;
      });
    }
  }, [own, rasters, block]);

  // The current word, in its own colours, over them.
  useEffect(() => {
    const context = top.current?.getContext("2d");
    if (!context || !block) return;
    context.clearRect(0, 0, block.w, block.h);
    if (!current) return;
    const { line, word } = current;
    const raster = rasters.lines.get(line.snapshot_id);
    if (!raster) return;
    const blobs = new Map(line.blobs.map((blob) => [blob.id, blob]));
    paint(context, raster, line.bbox.x - block.x, line.bbox.y - block.y, (id, x) => {
      const blob = blobs.get(id);
      if (!blob || blob.erased || !belongsAt(blob, word, line.bbox.x + x)) return null;
      return inkColor(blob, types.get(blob.id) ?? "", byType);
    });
  }, [current, rasters, block, types, byType]);

  // Follow the current word.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      revealInScroller(scroller.current, wash.current, { margin: 64 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [safeIndex, scale, entries]);

  useEffect(() => {
    if (!playing || !rasters.settled || !entries.length) return;
    const timer = window.setTimeout(() => {
      if (safeIndex < entries.length - 1) setIndex(safeIndex + 1);
      else if (repeat) setIndex(0);
      else setPlaying(false);
    }, SPEEDS[speed]);
    return () => window.clearTimeout(timer);
  }, [playing, rasters.settled, safeIndex, entries.length, repeat, speed]);

  useEffect(() => {
    const hidden = () => {
      if (document.hidden) setPlaying(false);
    };
    const screen = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("fullscreenchange", screen);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("fullscreenchange", screen);
    };
  }, []);

  const jump = (next: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(entries.length - 1, next)));
  };
  const togglePlay = () => {
    if (!playing && safeIndex === entries.length - 1) setIndex(0);
    setPlaying(!playing);
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.();
  };
  const inspect = () => {
    if (!current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    onInspect({ snapshot: current.line.snapshot_id, ids: wordBlobs(current).map((b) => b.id) });
  };

  // Keys: ← onward and → back (the page reads right to left), Space plays, Esc
  // goes back to editing. The editor's own keys stand aside while this is up.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName ?? "";
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tag) || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft") jump(safeIndex + 1);
      else if (event.key === "ArrowRight") jump(safeIndex - 1);
      else if (event.code === "Space") togglePlay();
      else if (event.key === "Escape" && !document.fullscreenElement) onExit();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const failed = own.filter((line) => rasters.failed.has(line.snapshot_id));
  const crop = current ? wordCrop(current) : null;
  const count = current ? wordCount(current.line, current.word) : null;
  const marks = current ? [...new Set([...types.values()])].sort((a, b) => a.localeCompare(b)) : [];
  const risks = current ? wordRisks(current.line, current.word, checks) : [];
  const opacity = othersOpacity(fade);

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col bg-well">
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
        {block ? (
          // dir=ltr: a picture of a page measured in pixels.
          <div dir="ltr" className="flex min-h-full w-max min-w-full" style={{ padding: PAD }}>
            <div
              className="relative m-auto flex-none rounded-[10px] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
              style={{ width: block.w * scale + 2 * SHEET, height: block.h * scale + 2 * SHEET }}
              role="img"
              aria-label={t("wordPlayback.fullPage", { page, index: safeIndex + 1 })}
            >
              <div className="absolute" style={{ left: SHEET, top: SHEET }}>
                {current && crop && (
                  <div
                    ref={wash}
                    className="absolute rounded-[4px]"
                    style={{
                      left: (current.line.bbox.x + crop.x - block.x) * scale,
                      top: (current.line.bbox.y + crop.y - block.y) * scale,
                      width: crop.w * scale,
                      height: crop.h * scale,
                      background: "var(--ov-aya-lit)",
                      boxShadow: "0 0 0 1.5px var(--ov-aya-lit-ring)",
                    }}
                  />
                )}
                {[base, top].map((layer, i) => (
                  <canvas
                    key={i}
                    ref={layer}
                    width={block.w}
                    height={block.h}
                    className="absolute left-0 top-0 block"
                    style={{
                      width: block.w * scale,
                      height: block.h * scale,
                      opacity: i === 0 ? opacity : 1,
                      imageRendering: scale > 1.6 ? "pixelated" : undefined,
                    }}
                  />
                ))}
              </div>
              {!rasters.settled && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-[13px] text-[color:var(--ov-text)]">
                  <BusyLabel>{t("wordPlayback.loading")}</BusyLabel>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="p-8 text-center text-[13px] text-ink-3">{t("wordPlayback.empty")}</p>
        )}
      </div>

      {/* The control bar: the word and how to move through the page, then how it is
          shown. On deep lapis, apart from the page. */}
      <div className="flex flex-none flex-col gap-2.5 bg-deep px-4 py-3 text-on-deep">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-none items-center gap-1.5" dir="ltr">
            <BarButton label={`${t("wordPlayback.next")} (←)`} onClick={() => jump(safeIndex + 1)}>
              <ChevronLeft size={18} />
            </BarButton>
            <button
              type="button"
              title={`${t(playing ? "wordPlayback.pause" : "wordPlayback.play")} (Space)`}
              aria-label={t(playing ? "wordPlayback.pause" : "wordPlayback.play")}
              onClick={togglePlay}
              disabled={!entries.length}
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-gold text-on-gold transition-[filter] hover:brightness-105 disabled:cursor-default disabled:opacity-50"
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <BarButton
              label={`${t("wordPlayback.previous")} (→)`}
              onClick={() => jump(safeIndex - 1)}
            >
              <ChevronRight size={18} />
            </BarButton>
            <BarButton
              label={t("wordPlayback.repeat")}
              active={repeat}
              onClick={() => setRepeat(!repeat)}
            >
              <Repeat size={16} />
            </BarButton>
          </div>

          {current && count && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1">
              <span lang="ar" dir="rtl" className="font-quran text-[26px] leading-tight">
                {current.word.text || t("wordPlayback.unlabelled")}
              </span>
              <span className="font-mono text-[12px] text-on-deep-2">
                {[
                  t("wordPlayback.aya", { aya: current.word.aya }),
                  t("wordPlayback.line", { line: current.line.line_number }),
                ].join(" · ")}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[12px] font-semibold ${
                  count.ok ? "text-on-deep-2" : "bg-warn text-on-warn"
                }`}
              >
                {t("wordPlayback.paws", count)}
              </span>
              {marks.map((type) => (
                <span
                  key={type || "untyped"}
                  className="inline-flex items-center gap-1 text-[12px]"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: `rgb(${(byType ? (TYPE_INK[type] ?? MARK_INK) : MARK_INK).join(",")})`,
                    }}
                  />
                  {type && (
                    <span dir="rtl" className="font-quran text-[15px] leading-none">
                      {subtypeGlyph(type)}
                    </span>
                  )}
                  {type ? typeName(type) : t("wordPlayback.unknown")}
                </span>
              ))}
              {risks.map((risk) => (
                <span
                  key={risk}
                  className="rounded-sm bg-warn-wash px-1.5 py-0.5 text-[11px] font-semibold text-warn-text"
                >
                  {t(`wordPlayback.risk.${risk}`)}
                </span>
              ))}
              {!wordBlobs(current).length && (
                <span className="text-[12px] text-on-deep-2">{t("wordPlayback.noInk")}</span>
              )}
            </div>
          )}

          <span className="ms-auto flex flex-none items-center gap-2">
            {preview && (
              <span className="rounded bg-white/10 px-2 py-0.5 text-[11.5px] font-semibold">
                {t("wordPlayback.preview")}
              </span>
            )}
            <button
              type="button"
              onClick={inspect}
              disabled={!current || !wordBlobs(current).length}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-control bg-white/10 px-3 text-[13px] font-semibold transition-colors hover:bg-white/20 disabled:cursor-default disabled:opacity-50"
            >
              <Pencil size={14} aria-hidden="true" />
              {t("wordPlayback.editWord")}
            </button>
            <BarButton label={`${t("wordPlayback.back")} (Esc)`} onClick={onExit}>
              <X size={18} />
            </BarButton>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 text-[12.5px]">
          <label className="flex min-w-[200px] flex-1 items-center gap-2.5">
            <span className="sr-only">{t("wordPlayback.jump")}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, entries.length - 1)}
              value={safeIndex}
              onChange={(event) => jump(Number(event.target.value))}
              className="min-w-0 flex-1 accent-gold"
              dir="rtl"
            />
            <span className="w-16 flex-none text-end font-mono tabular-nums" dir="ltr">
              {t("wordPlayback.position", { index: safeIndex + 1, total: entries.length })}
            </span>
          </label>

          {/* How much of the rest of the page shows: shown → dimmed → hidden. */}
          <span className="flex flex-none items-center gap-2.5">
            <span className="font-semibold">{t("wordPlayback.others")}</span>
            <span className="flex w-44 flex-col">
              <input
                type="range"
                min={0}
                max={100}
                value={fade}
                onChange={(event) => setFade(Number(event.target.value))}
                aria-label={t("wordPlayback.others")}
                aria-valuetext={
                  fade < 25
                    ? t("wordPlayback.othersShown")
                    : fade < 75
                      ? t("wordPlayback.othersDimmed")
                      : t("wordPlayback.othersHidden")
                }
                className="w-full accent-gold"
              />
              <span className="flex justify-between text-[10.5px] text-on-deep-2">
                <span>{t("wordPlayback.othersShown")}</span>
                <span>{t("wordPlayback.othersDimmed")}</span>
                <span>{t("wordPlayback.othersHidden")}</span>
              </span>
            </span>
          </span>

          <span className="flex flex-none items-center gap-3">
            <Check label={t("wordPlayback.types")} checked={byType} set={setByType} />
            <Check
              label={t("wordPlayback.riskyFirst", { count: risky.length })}
              checked={riskyFirst}
              set={(value) => {
                setRiskyFirst(value);
                setIndex(0);
              }}
            />
          </span>

          <span
            role="group"
            aria-label={t("wordPlayback.speed")}
            className="inline-flex flex-none rounded-lg bg-white/10 p-[3px]"
          >
            {(Object.keys(SPEEDS) as Speed[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={speed === value}
                onClick={() => setSpeed(value)}
                className={`h-7 cursor-pointer rounded-[6px] px-2.5 text-[12.5px] transition-colors ${
                  speed === value ? "bg-on-deep font-bold text-deep" : "hover:bg-white/10"
                }`}
              >
                {t(`wordPlayback.${value}`)}
              </button>
            ))}
          </span>

          <span className="flex flex-none items-center gap-1.5">
            <Pill
              active={fit === "width" && zoom === 1}
              onClick={() => {
                setFit("width");
                setZoom(1);
              }}
            >
              <ArrowLeftRight size={14} aria-hidden="true" />
              {t("wordPlayback.fitWidth")}
            </Pill>
            <Pill
              active={fit === "height" && zoom === 1}
              onClick={() => {
                setFit("height");
                setZoom(1);
              }}
            >
              <ArrowUpDown size={14} aria-hidden="true" />
              {t("wordPlayback.fitHeight")}
            </Pill>
            <BarButton
              label={full ? t("wordPlayback.exitFullscreen") : t("wordPlayback.fullscreen")}
              onClick={toggleFull}
            >
              {full ? <Minimize size={16} /> : <Maximize size={16} />}
            </BarButton>
          </span>
        </div>

        {failed.length > 0 && rasters.settled && (
          <div role="alert" className="flex items-center gap-2 text-[12px] text-on-deep-2">
            {t("wordPlayback.lineFailed", {
              lines: failed.map((line) => line.line_number).join("، "),
            })}
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="cursor-pointer font-semibold text-on-deep underline-offset-2 hover:underline"
            >
              {t("wordPlayback.retry")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Paint a line's ink into a layer at (dx, dy): each pixel's blob, by `colour`, which
 * says nothing for ink that is not drawn. Through a scratch canvas, so the line's
 * empty pixels leave its neighbours' ink alone where the boxes overlap. */
function paint(
  context: CanvasRenderingContext2D,
  raster: Raster,
  dx: number,
  dy: number,
  colour: (id: number, x: number) => readonly [number, number, number] | null,
) {
  if (!raster.width || !raster.height) return;
  const image = new ImageData(raster.width, raster.height);
  const data = image.data;
  for (let i = 0; i < raster.ids.length; i++) {
    const id = raster.ids[i];
    if (!id) continue;
    const rgb = colour(id, i % raster.width);
    if (!rgb) continue;
    const p = i * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  const scratch = document.createElement("canvas");
  scratch.width = raster.width;
  scratch.height = raster.height;
  scratch.getContext("2d")?.putImageData(image, 0, 0);
  context.drawImage(scratch, dx, dy);
}

/** Every line's label raster — which blob each pixel is. A line that fails is said and
 * skipped; the rest play. */
function useRasters(lines: CalibrationLine[], attempt: number): Rasters {
  const [state, setState] = useState<Rasters>({
    lines: new Map(),
    failed: new Set(),
    settled: false,
  });
  useEffect(() => {
    const abort = new AbortController();
    const found = new Map<string, Raster>();
    const failed = new Set<string>();
    setState({ lines: found, failed, settled: false });
    let next = 0;
    const load = async (line: CalibrationLine) => {
      if (!line.labels_url) throw new Error("missing labels");
      const response = await fetch(mediaUrl(line.labels_url), {
        credentials: "include",
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      // No colour management: the labels are ids, and a converted pixel is another blob.
      const labels = await createImageBitmap(await response.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      try {
        const canvas = document.createElement("canvas");
        canvas.width = labels.width;
        canvas.height = labels.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no canvas");
        context.drawImage(labels, 0, 0);
        return {
          ids: decodeLabels(context.getImageData(0, 0, labels.width, labels.height).data),
          width: labels.width,
          height: labels.height,
        };
      } finally {
        labels.close();
      }
    };
    void (async () => {
      // A few at a time: a page is fifteen lines or so, each a decode.
      await Promise.all(
        Array.from({ length: Math.min(4, lines.length) }, async () => {
          while (next < lines.length && !abort.signal.aborted) {
            const line = lines[next++];
            try {
              found.set(line.snapshot_id, await load(line));
            } catch {
              if (!abort.signal.aborted) failed.add(line.snapshot_id);
            }
          }
        }),
      );
      if (!abort.signal.aborted)
        setState({ lines: new Map(found), failed: new Set(failed), settled: true });
    })();
    return () => abort.abort();
  }, [lines, attempt]);
  return state;
}

function BarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
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
      onClick={onClick}
      className={`flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-control transition-colors ${
        active ? "bg-on-deep text-deep" : "bg-white/10 hover:bg-white/20"
      }`}
    >
      {children}
    </button>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control px-2.5 text-[12.5px] font-semibold transition-colors ${
        active ? "bg-on-deep text-deep" : "bg-white/10 hover:bg-white/20"
      }`}
    >
      {children}
    </button>
  );
}

function Check({
  label,
  checked,
  set,
}: {
  label: string;
  checked: boolean;
  set: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => set(event.target.checked)}
        className="h-4 w-4 accent-gold"
      />
      {label}
    </label>
  );
}

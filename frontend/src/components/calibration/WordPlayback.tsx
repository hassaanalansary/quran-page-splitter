import { ChevronLeft, ChevronRight, Pause, Pencil, Play, Repeat, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { mediaUrl, pageImageUrl } from "@/lib/api";
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
  BODY_INK,
  MARK_INK,
  TYPE_INK,
  containedPoint,
  inkColor,
  paintPlaybackInk,
  playbackWords,
  wordAtPixel,
  wordBlobs,
  wordCrop,
  type PlaybackWord,
} from "@/lib/calibration/playback";
import type { CalibrationBlob, CalibrationLine } from "@/lib/calibration/types";

import { attentionKey, exceptionKey, useTypeName } from "./labels";
import { SUBTYPE_GLYPHS, subtypeGlyph, type Subtype } from "./subtypes";

const SPEEDS = { slow: 2400, normal: 1300, fast: 650 } as const;
type Raster = { source: ImageBitmap; ids: Uint32Array; width: number; height: number };
type Assets = {
  page: ImageBitmap | null;
  lines: Map<string, Raster>;
  settled: boolean;
  failed: boolean;
};

/** Read-only playback is intentionally separate from the editor's alignment preview. */
export function WordPlayback({
  mushafId,
  page,
  lines,
  expectations,
  checks,
  preview,
  disabled,
  onInspect,
}: {
  mushafId: string;
  page: number;
  lines: CalibrationLine[];
  expectations: Expectations;
  /** Every word's marks against its text's: a word they do not fit is worth a look. */
  checks?: MarkChecks;
  preview: boolean;
  disabled: boolean;
  onInspect: (selection: BlobSelection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="h-8 flex-none gap-1.5 px-2 text-[12px]"
        disabled={disabled || !lines.some((line) => line.words.length)}
        onClick={() => setOpen(true)}
      >
        <Play size={14} />
        {t("wordPlayback.open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex h-[92dvh] w-[96vw] max-w-6xl flex-col gap-3 overflow-hidden p-3 sm:p-4"
          aria-describedby={undefined}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DialogHeader className="flex-none pe-8">
            <DialogTitle className="text-base tracking-normal">
              {t("wordPlayback.title", { page })}
            </DialogTitle>
          </DialogHeader>
          {open && (
            <Player
              key={page}
              mushafId={mushafId}
              page={page}
              lines={lines}
              expectations={expectations}
              preview={preview}
              onInspect={(selection) => {
                setOpen(false);
                onInspect(selection);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function useAssets(
  mushafId: string,
  page: number,
  lines: CalibrationLine[],
  attempt: number,
): Assets {
  const [assets, setAssets] = useState<Assets>({
    page: null,
    lines: new Map(),
    settled: false,
    failed: false,
  });
  useEffect(() => {
    const abort = new AbortController();
    const images: ImageBitmap[] = [];
    const result: Assets = { page: null, lines: new Map(), settled: false, failed: false };
    setAssets(result);
    const bitmap = async (url: string) => {
      const response = await fetch(url, { credentials: "include", signal: abort.signal });
      if (!response.ok) throw new Error(String(response.status));
      const image = await createImageBitmap(await response.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      if (abort.signal.aborted) {
        image.close();
        throw new Error("aborted");
      }
      images.push(image);
      return image;
    };
    void (async () => {
      try {
        result.page = await bitmap(pageImageUrl(mushafId, page));
      } catch {
        result.failed = true;
      }
      // Bound concurrent decodes: a page can contain thousands of components.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, lines.length) }, async () => {
          while (next < lines.length && !abort.signal.aborted) {
            const line = lines[next++];
            try {
              if (!line.image_url || !line.labels_url) throw new Error("missing snapshot");
              const source = await bitmap(mediaUrl(line.image_url));
              const labels = await bitmap(mediaUrl(line.labels_url));
              if (
                source.width !== labels.width ||
                source.height !== labels.height ||
                source.width !== line.bbox.w ||
                source.height !== line.bbox.h
              )
                throw new Error("raster geometry mismatch");
              const canvas = document.createElement("canvas");
              canvas.width = labels.width;
              canvas.height = labels.height;
              const context = canvas.getContext("2d", { willReadFrequently: true });
              if (!context) throw new Error("no canvas");
              context.drawImage(labels, 0, 0);
              result.lines.set(line.snapshot_id, {
                source,
                width: labels.width,
                height: labels.height,
                ids: decodeLabels(context.getImageData(0, 0, labels.width, labels.height).data),
              });
            } catch {
              result.failed = true;
            }
          }
        }),
      );
      if (!abort.signal.aborted) setAssets({ ...result, settled: true });
    })();
    return () => {
      abort.abort();
      images.forEach((image) => image.close());
    };
  }, [mushafId, page, lines, attempt]);
  return assets;
}

function Player({
  mushafId,
  page,
  lines,
  expectations,
  checks,
  preview,
  onInspect,
}: {
  mushafId: string;
  page: number;
  lines: CalibrationLine[];
  expectations: Expectations;
  checks?: MarkChecks;
  preview: boolean;
  onInspect: (selection: BlobSelection) => void;
}) {
  const { t } = useTranslation();
  const typeName = useTypeName();
  /** Words with something worth a look (see `wordRisks`) played first, the rest after. */
  const [riskyFirst, setRiskyFirst] = useState(false);
  const all = useMemo(() => playbackWords(lines), [lines]);
  const risky = useMemo(
    () => all.filter((entry) => wordRisks(entry.line, entry.word, checks).length > 0),
    [all, checks],
  );
  const entries = useMemo(
    () => (riskyFirst ? [...risky, ...all.filter((entry) => !risky.includes(entry))] : all),
    [all, risky, riskyFirst],
  );
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [speed, setSpeed] = useState<keyof typeof SPEEDS>("normal");
  const [repeat, setRepeat] = useState(false);
  const [types, setTypes] = useState(true);
  const [dim, setDim] = useState(true);
  const [boundaries, setBoundaries] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const assets = useAssets(mushafId, page, lines, attempt);
  const safeIndex = Math.min(index, Math.max(0, entries.length - 1));
  const current = entries[safeIndex];
  const blobs = useMemo(() => (current ? wordBlobs(current) : []), [current]);
  const selectedBlob = blobs.find((blob) => blob.id === selected);
  const typeOf = (blob: CalibrationBlob) =>
    isTyped(blob)
      ? blob.subtype
      : (expectedType(blob, current.line.snapshot_id, expectations)?.subtype ?? "");
  const typeMap = useMemo(
    () =>
      new Map(
        blobs.map((blob) => [
          blob.id,
          isTyped(blob)
            ? blob.subtype
            : (expectedType(blob, current.line.snapshot_id, expectations)?.subtype ?? ""),
        ]),
      ),
    [blobs, current, expectations],
  );
  const jump = (next: number) => {
    setPlaying(false);
    setSelected(null);
    setIndex(Math.max(0, Math.min(entries.length - 1, next)));
  };

  useEffect(() => {
    if (!playing || !assets.settled || assets.failed || !entries.length) return;
    const timer = window.setTimeout(() => {
      setSelected(null);
      if (safeIndex < entries.length - 1) setIndex(safeIndex + 1);
      else if (repeat) setIndex(0);
      else setPlaying(false);
    }, SPEEDS[speed]);
    return () => window.clearTimeout(timer);
  }, [playing, assets.settled, assets.failed, safeIndex, entries.length, repeat, speed]);

  useEffect(() => {
    const hidden = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  const typeLabel = (type: string) => (type ? typeName(type) : t("wordPlayback.unknown"));
  if (!current) return <p>{t("wordPlayback.empty")}</p>;
  const count = wordCount(current.line, current.word);
  const togglePlay = () => {
    if (!playing && safeIndex === entries.length - 1) setIndex(0);
    setPlaying(!playing);
    setSelected(null);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      onKeyDown={(event) => {
        if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test((event.target as HTMLElement).tagName)) return;
        if (event.key === "ArrowLeft") jump(safeIndex + 1);
        else if (event.key === "ArrowRight") jump(safeIndex - 1);
        else if (event.code === "Space") togglePlay();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-2 text-[12px]">
        <span className="text-text-muted">
          {t(preview ? "wordPlayback.preview" : "wordPlayback.live")}
        </span>
        <Toggle label={t("wordPlayback.types")} checked={types} set={setTypes} />
        <Toggle label={t("wordPlayback.dim")} checked={dim} set={setDim} />
        <Toggle label={t("wordPlayback.boundaries")} checked={boundaries} set={setBoundaries} />
        <Toggle
          label={t("wordPlayback.riskyFirst", { count: risky.length })}
          checked={riskyFirst}
          set={(value) => {
            setRiskyFirst(value);
            setIndex(0);
            setSelected(null);
          }}
        />
        <span className="flex items-center gap-1">
          <Swatch color={BODY_INK} />
          {t("wordPlayback.body")}
        </span>
        <span className="flex items-center gap-1">
          <Swatch color={MARK_INK} dashed />
          {t("wordPlayback.mark")}
        </span>
      </div>
      {!assets.settled && (
        <div role="status" className="text-[12px]">
          {t("wordPlayback.loading")}
        </div>
      )}
      {assets.failed && assets.settled && (
        <div role="alert" className="flex items-center gap-2 text-[12px] text-error">
          {t("wordPlayback.error")}
          <Control label={t("wordPlayback.retry")} onClick={() => setAttempt((n) => n + 1)}>
            <RotateCcw size={16} />
          </Control>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(140px,1fr)_minmax(170px,1fr)] gap-3 md:grid-cols-[minmax(0,1fr)_330px] md:grid-rows-1">
        <PageInk
          page={page}
          entries={entries}
          index={safeIndex}
          assets={assets}
          types={typeMap}
          distinguishTypes={types}
          dim={dim}
          boundaries={boundaries}
          selected={selectedBlob?.id ?? null}
          onJump={jump}
        />
        <section className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto border-t border-border pt-2 md:border-s md:border-t-0 md:ps-3 md:pt-0">
          <div className="flex items-baseline justify-between gap-2">
            <strong dir="rtl" className="min-w-0 break-words text-xl leading-relaxed">
              {current.word.text || t("wordPlayback.unlabelled")}
            </strong>
            <span className="flex-none text-[11px] text-text-muted">
              {t("wordPlayback.aya", { aya: current.word.aya })}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-secondary">
            <span>{t("wordPlayback.line", { line: current.line.line_number })}</span>
            <span>
              {t("wordPlayback.bodies", { count: blobs.filter((b) => b.role === "body").length })}
            </span>
            <span>
              {t("wordPlayback.marks", { count: blobs.filter((b) => b.role === "mark").length })}
            </span>
            <span className={count.ok ? "" : "font-semibold text-error"}>
              {t("wordPlayback.paws", count)}
            </span>
          </div>
          {wordRisks(current.line, current.word, checks).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {wordRisks(current.line, current.word, checks).map((risk) => (
                <span
                  key={risk}
                  className="rounded-sm bg-warning-bg px-1.5 py-0.5 text-[10.5px] text-[#8a4b0d]"
                >
                  {t(`wordPlayback.risk.${risk}`)}
                </span>
              ))}
            </div>
          )}
          <WordInk
            entry={current}
            raster={assets.lines.get(current.line.snapshot_id)}
            types={typeMap}
            distinguishTypes={types}
            dim={dim}
            selected={selectedBlob}
            onSelect={(id) => {
              setPlaying(false);
              setSelected(id);
            }}
          />
          {!blobs.length && <p className="text-[12px] text-warning">{t("wordPlayback.noInk")}</p>}
          <div className="flex flex-wrap gap-2 text-[11px]">
            {[...new Set(blobs.filter((b) => b.role === "mark").map(typeOf))].map((type) => (
              <span key={type} className="flex items-center gap-1">
                <Swatch color={types ? (TYPE_INK[type] ?? MARK_INK) : MARK_INK} dashed />
                <span dir="rtl">{SUBTYPE_GLYPHS[type as Subtype] ?? subtypeGlyph(type)}</span>
                {typeLabel(type)}
              </span>
            ))}
          </div>
          <table className="w-full table-fixed text-start text-[11px]">
            <caption className="py-1 text-start font-semibold">
              {t("wordPlayback.components")}
            </caption>
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="w-12 py-1 text-start">{t("wordPlayback.id")}</th>
                <th className="text-start">{t("wordPlayback.role")}</th>
                <th className="w-10 text-end">{t("wordPlayback.contribution")}</th>
              </tr>
            </thead>
            <tbody>
              {blobs.map((blob) => (
                <tr
                  key={blob.id}
                  className={`border-b border-border ${selected === blob.id ? "bg-orange-tint" : ""}`}
                >
                  <td className="py-1 align-top">
                    <button
                      type="button"
                      className="min-h-8 cursor-pointer underline underline-offset-2"
                      aria-label={t("wordPlayback.selectBlob", { id: blob.id })}
                      aria-pressed={selected === blob.id}
                      onClick={() => {
                        setPlaying(false);
                        setSelected(selected === blob.id ? null : blob.id);
                      }}
                    >
                      #{blob.id}
                    </button>
                  </td>
                  <td className="py-1">
                    <span className="flex items-center gap-1.5">
                      <Swatch
                        color={inkColor(blob, typeOf(blob), types)}
                        dashed={blob.role === "mark"}
                      />
                      {blob.role === "body" ? t("wordPlayback.body") : typeLabel(typeOf(blob))}
                    </span>
                    {blob.role === "mark" && (
                      <span className="text-[10px] text-text-muted">
                        {t(
                          isTyped(blob)
                            ? "wordPlayback.confirmed"
                            : typeOf(blob)
                              ? "wordPlayback.suggested"
                              : "wordPlayback.missingType",
                        )}
                      </span>
                    )}
                    {blob.allocations.length > 1 && (
                      <span className="block text-[10px] text-text-muted">
                        {t("wordPlayback.shared")}
                      </span>
                    )}
                  </td>
                  <td className="text-end tabular-nums">
                    {blob.role === "body"
                      ? (blob.allocations.find((a) => a.word_id === current.word.word_id)?.paws ??
                        0)
                      : 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {selectedBlob && (
            <div className="flex flex-col gap-1 border-b border-border pb-2 text-[11px]">
              <span>
                {t("wordPlayback.source")}:{" "}
                {t(`calibration.source.${selectedBlob.decision_source}`)}
              </span>
              <span>
                {t("wordPlayback.score")}: {selectedBlob.body_score}/14 · {selectedBlob.w} ×{" "}
                {selectedBlob.h}
              </span>
              {selectedBlob.exception && (
                <span>
                  {t("wordPlayback.exception")}:{" "}
                  {exceptionKey(selectedBlob.exception)
                    ? t(exceptionKey(selectedBlob.exception)!)
                    : selectedBlob.exception}
                </span>
              )}
              {selectedBlob.attention.map((flag) => (
                <span key={flag}>
                  {t("wordPlayback.attention")}:{" "}
                  {attentionKey(flag) ? t(attentionKey(flag)!) : flag}
                </span>
              ))}
              <Button
                variant="outline"
                className="mt-1 h-8 gap-2"
                onClick={() =>
                  onInspect({ snapshot: current.line.snapshot_id, ids: [selectedBlob.id] })
                }
              >
                <Pencil size={13} />
                {t("wordPlayback.inspect")}
              </Button>
            </div>
          )}
          <p className="text-[11px] text-text-muted">
            {t("wordPlayback.detached", {
              count: current.line.blobs.filter(
                (b) => (b.role === "body" || b.role === "mark") && !b.allocations.length,
              ).length,
            })}
          </p>
        </section>
      </div>
      <div className="flex flex-none flex-col gap-2 border-t border-border pt-2">
        <input
          type="range"
          min={0}
          max={Math.max(0, entries.length - 1)}
          value={safeIndex}
          onChange={(e) => jump(Number(e.target.value))}
          aria-label={t("wordPlayback.jump")}
          className="w-full accent-orange"
          dir="rtl"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <select
            aria-label={t("wordPlayback.jump")}
            value={safeIndex}
            onChange={(e) => jump(Number(e.target.value))}
            className="h-9 min-w-0 max-w-full flex-1 rounded-sm border border-border-strong bg-white px-2 text-[12px] md:max-w-72"
          >
            {entries.map((entry, i) => (
              <option key={`${entry.line.snapshot_id}:${entry.wordIndex}`} value={i}>
                {i + 1}. {entry.word.text || t("wordPlayback.unlabelled")} · {entry.word.aya}
              </option>
            ))}
          </select>
          <span className="w-20 text-center text-[12px] tabular-nums" dir="ltr">
            {t("wordPlayback.position", { index: safeIndex + 1, total: entries.length })}
          </span>
          <div className="flex items-center gap-1" dir="ltr">
            <Control
              label={t("wordPlayback.previous")}
              onClick={() => jump(safeIndex - 1)}
              disabled={!safeIndex}
            >
              <ChevronRight size={17} />
            </Control>
            <Control
              label={t(playing ? "wordPlayback.pause" : "wordPlayback.play")}
              onClick={togglePlay}
              disabled={!assets.settled || assets.failed}
              active={playing}
            >
              {playing ? <Pause size={17} /> : <Play size={17} />}
            </Control>
            <Control
              label={t("wordPlayback.next")}
              onClick={() => jump(safeIndex + 1)}
              disabled={safeIndex === entries.length - 1}
            >
              <ChevronLeft size={17} />
            </Control>
            <Control
              label={t("wordPlayback.repeat")}
              onClick={() => setRepeat(!repeat)}
              active={repeat}
            >
              <Repeat size={16} />
            </Control>
          </div>
          <select
            aria-label={t("wordPlayback.speed")}
            value={speed}
            onChange={(e) => setSpeed(e.target.value as keyof typeof SPEEDS)}
            className="h-9 rounded-sm border border-border-strong bg-white px-2 text-[12px]"
          >
            {Object.keys(SPEEDS).map((value) => (
              <option key={value} value={value}>
                {t(`wordPlayback.${value as keyof typeof SPEEDS}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function overlay(
  raster: Raster,
  entry: PlaybackWord,
  types: ReadonlyMap<number, string>,
  distinguishTypes: boolean,
  dim: boolean,
) {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(raster.width, raster.height);
  pixels.data.set(
    paintPlaybackInk(
      raster.ids,
      raster.width,
      entry.line,
      entry.word,
      types,
      distinguishTypes,
      dim,
    ),
  );
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function PageInk({
  page,
  entries,
  index,
  assets,
  types,
  distinguishTypes,
  dim,
  boundaries,
  selected,
  onJump,
}: {
  page: number;
  entries: PlaybackWord[];
  index: number;
  assets: Assets;
  types: ReadonlyMap<number, string>;
  distinguishTypes: boolean;
  dim: boolean;
  boundaries: boolean;
  selected: number | null;
  onJump: (index: number) => void;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = entries[index];
  const natural = {
    w: assets.page?.width ?? Math.max(1, ...entries.map((e) => e.line.bbox.x + e.line.bbox.w)),
    h: assets.page?.height ?? Math.max(1, ...entries.map((e) => e.line.bbox.y + e.line.bbox.h)),
  };
  const k = Math.min(1, 1400 / natural.w);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !current) return;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, natural.w, natural.h);
    ctx.globalAlpha = dim ? 0.28 : 1;
    if (assets.page) ctx.drawImage(assets.page, 0, 0);
    for (const [snapshot, raster] of assets.lines) {
      const line = entries.find((e) => e.line.snapshot_id === snapshot)?.line;
      if (line) ctx.drawImage(raster.source, line.bbox.x, line.bbox.y);
    }
    ctx.globalAlpha = 1;
    const raster = assets.lines.get(current.line.snapshot_id);
    if (raster)
      ctx.drawImage(
        overlay(raster, current, types, distinguishTypes, dim),
        current.line.bbox.x,
        current.line.bbox.y,
      );
    if (boundaries) {
      ctx.strokeStyle = "#004ca0";
      ctx.lineWidth = 2 / k;
      ctx.strokeRect(
        current.word.end_x,
        current.line.bbox.y,
        Math.max(1, current.word.start_x - current.word.end_x),
        current.line.bbox.h,
      );
    }
    const blob = current.line.blobs.find((b) => b.id === selected);
    if (blob) {
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 2 / k;
      ctx.setLineDash(blob.role === "mark" ? [4 / k, 3 / k] : []);
      ctx.strokeRect(blob.x - 2, blob.y - 2, blob.w + 4, blob.h + 4);
      ctx.setLineDash([]);
    }
  }, [
    assets,
    entries,
    current,
    types,
    distinguishTypes,
    dim,
    boundaries,
    selected,
    k,
    natural.w,
    natural.h,
  ]);
  return (
    <div
      className="flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-bg-surface"
      tabIndex={0}
      aria-label={t("wordPlayback.fullPage", { page, index: index + 1 })}
    >
      <canvas
        ref={canvas}
        width={Math.round(natural.w * k)}
        height={Math.round(natural.h * k)}
        role="img"
        aria-label={t("wordPlayback.fullPage", { page, index: index + 1 })}
        data-word-playback="page"
        className="block max-h-full max-w-full cursor-pointer object-contain"
        style={{ aspectRatio: `${natural.w}/${natural.h}` }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = containedPoint(
            event.clientX - rect.left,
            event.clientY - rect.top,
            rect.width,
            rect.height,
            natural.w,
            natural.h,
          );
          if (!point) return;
          const { x, y } = point;
          const line = entries.find(
            (e) =>
              y >= e.line.bbox.y &&
              y < e.line.bbox.y + e.line.bbox.h &&
              x >= e.line.bbox.x &&
              x < e.line.bbox.x + e.line.bbox.w,
          )?.line;
          if (!line) return;
          const raster = assets.lines.get(line.snapshot_id);
          if (!raster) return;
          const id =
            raster.ids[Math.floor(y - line.bbox.y) * raster.width + Math.floor(x - line.bbox.x)] ??
            0;
          const next = wordAtPixel(entries, line, id, x);
          if (next >= 0) onJump(next);
        }}
      />
    </div>
  );
}

function WordInk({
  entry,
  raster,
  types,
  distinguishTypes,
  dim,
  selected,
  onSelect,
}: {
  entry: PlaybackWord;
  raster?: Raster;
  types: ReadonlyMap<number, string>;
  distinguishTypes: boolean;
  dim: boolean;
  selected?: CalibrationBlob;
  onSelect: (id: number | null) => void;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const crop = wordCrop(entry);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, crop.w, crop.h);
    if (!raster) return;
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.drawImage(raster.source, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    ctx.globalAlpha = 1;
    ctx.drawImage(
      overlay(raster, entry, types, distinguishTypes, dim),
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      0,
      0,
      crop.w,
      crop.h,
    );
    if (selected) {
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 1;
      ctx.setLineDash(selected.role === "mark" ? [3, 2] : []);
      ctx.strokeRect(
        selected.x - entry.line.bbox.x - crop.x - 2,
        selected.y - entry.line.bbox.y - crop.y - 2,
        selected.w + 4,
        selected.h + 4,
      );
      ctx.setLineDash([]);
    }
  }, [raster, entry, types, distinguishTypes, dim, selected, crop.x, crop.y, crop.w, crop.h]);
  return (
    <div className="flex h-32 flex-none items-center justify-center overflow-hidden border-y border-border bg-white">
      <canvas
        ref={canvas}
        width={Math.ceil(crop.w)}
        height={Math.ceil(crop.h)}
        className="max-h-full max-w-full cursor-pointer object-contain"
        style={{ width: "100%", aspectRatio: `${crop.w}/${crop.h}` }}
        role="img"
        aria-label={t("wordPlayback.closeup")}
        data-word-playback="word"
        onClick={(event) => {
          if (!raster) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const point = containedPoint(
            event.clientX - rect.left,
            event.clientY - rect.top,
            rect.width,
            rect.height,
            crop.w,
            crop.h,
          );
          if (!point) return;
          const x = Math.floor(crop.x + point.x),
            y = Math.floor(crop.y + point.y);
          const id = raster.ids[y * raster.width + x];
          onSelect(wordBlobs(entry).some((blob) => blob.id === id) ? id : null);
        }}
      />
    </div>
  );
}

function Swatch({ color, dashed = false }: { color: readonly number[]; dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="h-3 w-3 flex-none border-2"
      style={{
        borderColor: `rgb(${color.join(",")})`,
        background: dashed ? "white" : `rgb(${color.join(",")})`,
        borderStyle: dashed ? "dashed" : "solid",
      }}
    />
  );
}
function Toggle({
  label,
  checked,
  set,
}: {
  label: string;
  checked: boolean;
  set: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => set(e.target.checked)}
        className="accent-orange"
      />
      {label}
    </label>
  );
}
function Control({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-sm border border-border-strong disabled:cursor-default disabled:opacity-40 ${active ? "bg-orange text-white" : "bg-white text-text-primary hover:bg-bg-surface"}`}
    >
      {children}
    </button>
  );
}

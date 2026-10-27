import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SatrDialogClose } from "@/components/app/SatrDialog";
import type { AyaGroup } from "@/lib/review/recompute";

/** Milliseconds each aya stays highlighted, per speed setting. */
const SPEEDS = { slow: 2500, normal: 1300, fast: 650 } as const;
type Speed = keyof typeof SPEEDS;

/** Screen px kept clear around the page, and the narrowest a side column may get. */
const MARGIN = 16;
const SIDE = 240;
/** Below this width the sides fold under the page, as a bar. */
const STACKED = 768;
/** The bar's height when folded under the page. */
const BAR = 168;

/**
 * Plays the page's cuts back the way a mushaf app would: the page image with
 * exactly one aya lit at a time, stepping on a timer or by hand. It reads the
 * LIVE derived ayat, so it previews the edits in the session — this is the
 * fastest way to tell whether the separators actually landed right.
 *
 * Laid out as an app shows a page: the page as tall as the window, its corners
 * rounded, with what is lit and the progress under it on one side and the controls
 * on the other. The surroundings take the app's theme; the page stays a scan.
 */
export function AyaPreviewDialog({
  open,
  onOpenChange,
  imageUrl,
  natural,
  ayat,
  title,
  suraName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string;
  /** Natural page-image size — the coordinate space of the aya rects. */
  natural: { w: number; h: number } | null;
  ayat: AyaGroup[];
  title: string;
  suraName: (n: number) => string;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>("normal");
  const [room, setRoom] = useState({ w: 0, h: 0 });
  // A state, not a ref: the portal mounts the content a render after `open` turns.
  const [content, setContent] = useState<HTMLDivElement | null>(null);

  const total = ayat.length;
  const safeIndex = total ? Math.min(index, total - 1) : 0;
  const current: AyaGroup | undefined = ayat[safeIndex];

  // Every opening starts a fresh run from the first aya.
  useEffect(() => {
    if (open) {
      setIndex(0);
      setPlaying(true);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !playing || total === 0) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % total), SPEEDS[speed]);
    return () => window.clearInterval(id);
  }, [open, playing, speed, total]);

  // ←/→ step through ayat (left advances, as pages and ayat both run RTL); Space
  // plays and pauses.
  useEffect(() => {
    if (!open || total === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (e.key === "ArrowLeft") {
        setIndex((i) => (i + 1) % total);
        setPlaying(false);
      } else if (e.key === "ArrowRight") {
        setIndex((i) => (i - 1 + total) % total);
        setPlaying(false);
      } else if (e.code === "Space") setPlaying((p) => !p);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, total]);

  // The room the window leaves, measured: the page's size follows from it.
  useLayoutEffect(() => {
    if (!content) return;
    const measure = () => setRoom({ w: content.clientWidth, h: content.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [content]);

  const step = (delta: number) => {
    if (!total) return;
    setPlaying(false);
    setIndex((i) => (i + delta + total) % total);
  };

  const stacked = room.w > 0 && room.w < STACKED;
  const ratio = natural ? natural.w / natural.h : 0;
  let size = { w: 0, h: 0 };
  if (ratio && room.w && room.h) {
    const maxW = stacked ? room.w - 2 * MARGIN : room.w - 2 * SIDE - 4 * MARGIN;
    const maxH = room.h - 2 * MARGIN - (stacked ? BAR : 0);
    const h = Math.max(0, Math.min(maxH, maxW / ratio));
    size = { w: h * ratio, h };
  }

  const lines = current?.lines ?? [];
  const where =
    lines.length > 1
      ? t("review.previewLines", { from: lines[0], to: lines[lines.length - 1] })
      : lines.length === 1
        ? t("review.previewLine", { n: lines[0] })
        : null;

  const nowPlaying = current && (
    <div className="flex w-full max-w-[320px] flex-col gap-2.5">
      <span className="font-display text-[22px] font-semibold leading-tight">
        {t("review.previewAya", { sura: suraName(current.sura), aya: current.aya })}
      </span>
      <span className="font-mono text-[12.5px] text-ink-3">
        {[
          t("review.previewPosition", { index: safeIndex + 1, total }),
          where,
          t("review.previewSegments", { count: current.rects.length }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {/* Where the run is, as a player's bar: done in lapis, the lit aya gold. Each
          aya's piece takes you there. */}
      <div dir="rtl" className="mt-1 flex items-center gap-[3px]">
        {ayat.map((a, i) => (
          <button
            key={a.key}
            type="button"
            title={t("review.previewAya", { sura: suraName(a.sura), aya: a.aya })}
            aria-label={t("review.previewAya", { sura: suraName(a.sura), aya: a.aya })}
            aria-current={i === safeIndex ? "true" : undefined}
            onClick={() => {
              setPlaying(false);
              setIndex(i);
            }}
            className="flex h-4 min-w-0 flex-1 cursor-pointer items-center"
          >
            <span
              className={`h-1.5 w-full rounded-[3px] transition-colors ${
                i < safeIndex ? "bg-lapis" : i === safeIndex ? "bg-gold" : "bg-sunk"
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  );

  const controls = (
    <div className="flex flex-col items-center gap-4">
      {/* Left advances, as the keys do: the page reads right to left. */}
      <div className="flex items-center gap-2.5" dir="ltr">
        <Round title={t("review.previewNext")} onClick={() => step(1)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </Round>
        <button
          type="button"
          title={playing ? t("review.previewPause") : t("review.previewPlay")}
          aria-label={playing ? t("review.previewPause") : t("review.previewPlay")}
          onClick={() => setPlaying((p) => !p)}
          className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-lapis text-on-lapis transition-colors hover:bg-lapis/90"
        >
          {playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
        </button>
        <Round title={t("review.previewPrev")} onClick={() => step(-1)}>
          <ChevronRight size={18} aria-hidden="true" />
        </Round>
      </div>
      <div
        role="group"
        aria-label={t("review.previewSpeed")}
        className="inline-flex rounded-lg bg-sunk p-[3px]"
      >
        {(Object.keys(SPEEDS) as Speed[]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={speed === s}
            onClick={() => setSpeed(s)}
            className={`h-8 cursor-pointer rounded-control px-3 text-[13px] transition-colors ${
              speed === s
                ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "font-medium text-ink-2 hover:text-ink"
            }`}
          >
            {t(`review.previewSpeed_${s}`)}
          </button>
        ))}
      </div>
      {!stacked && (
        <span className="text-center text-[12px] text-ink-3">{t("review.previewKeys")}</span>
      )}
    </div>
  );

  const page =
    current && natural && size.w > 0 ? (
      // Sized to the window, so the overlay's percentages line up with the rendered
      // page. The scan stays on white whatever the theme.
      <div
        className="relative flex-none overflow-hidden rounded-[18px] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.22)]"
        style={{ width: size.w, height: size.h }}
      >
        <img
          src={imageUrl}
          alt={title}
          className="block h-full w-full select-none"
          draggable={false}
        />
        {current.rects.map((r, i) => (
          <span
            key={i}
            // `multiply` keeps the ink readable through the tint — a highlighter
            // over paper, which is what the app does.
            style={{
              position: "absolute",
              left: `${(r.x / natural.w) * 100}%`,
              top: `${(r.y / natural.h) * 100}%`,
              width: `${(r.w / natural.w) * 100}%`,
              height: `${(r.h / natural.h) * 100}%`,
              background: "var(--ov-aya-lit)",
              boxShadow: "0 0 0 1.5px var(--ov-aya-lit-ring)",
              mixBlendMode: "multiply",
              borderRadius: 4,
            }}
          />
        ))}
      </div>
    ) : null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={setContent}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="fixed inset-0 z-50 flex bg-well text-ink outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t("review.previewHint")}
          </DialogPrimitive.Description>
          <SatrDialogClose className="absolute end-4 top-4 z-10 bg-card shadow-[var(--shadow-card)]" />

          {total === 0 || !current || !natural ? (
            <div className="m-auto flex max-w-[360px] flex-col items-center gap-2 px-6 text-center">
              <strong className="font-display text-[20px] font-semibold">{title}</strong>
              <p className="m-0 text-[13px] text-ink-3">{t("review.previewEmpty")}</p>
            </div>
          ) : stacked ? (
            <div className="flex w-full flex-col items-center">
              <div className="flex min-h-0 flex-1 items-center justify-center">{page}</div>
              <div
                className="flex w-full flex-none flex-col items-center justify-center gap-3 border-t border-rule bg-sheet px-4"
                style={{ height: BAR }}
              >
                {nowPlaying}
                {controls}
              </div>
            </div>
          ) : (
            <div className="flex w-full items-stretch">
              {/* What is lit, and the progress under it, at the foot of the start
                  side — where an app's player sits. */}
              <div className="flex min-w-0 flex-1 flex-col justify-between gap-6 p-7">
                <div className="flex flex-col gap-1">
                  <strong className="font-display text-[20px] font-semibold leading-tight">
                    {title}
                  </strong>
                  <span className="max-w-[320px] text-[13px] leading-normal text-ink-3">
                    {t("review.previewHint")}
                  </span>
                </div>
                {nowPlaying}
              </div>
              <div className="flex flex-none items-center justify-center">{page}</div>
              <div className="flex min-w-0 flex-1 items-center justify-center p-7">{controls}</div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Round({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-rule-2 bg-card text-ink transition-colors hover:bg-sheet"
    >
      {children}
    </button>
  );
}

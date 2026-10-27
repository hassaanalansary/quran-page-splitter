import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SatrDialogClose, SatrDialogFrame } from "@/components/app/SatrDialog";
import type { AyaGroup } from "@/lib/review/recompute";

/** Milliseconds each aya stays highlighted, per speed setting. */
const SPEEDS = { slow: 2500, normal: 1300, fast: 650 } as const;
type Speed = keyof typeof SPEEDS;

/**
 * Plays the page's cuts back the way a mushaf app would: the page image with
 * exactly one aya lit at a time, stepping on a timer or by hand. It reads the
 * LIVE derived ayat, so it previews the edits in the session — this is the
 * fastest way to tell whether the separators actually landed right.
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

  // ←/→ step through ayat (left advances, as pages and ayat both run RTL).
  useEffect(() => {
    if (!open || total === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (e.key === "ArrowLeft") setIndex((i) => (i + 1) % total);
      else if (e.key === "ArrowRight") setIndex((i) => (i - 1 + total) % total);
      else return;
      e.preventDefault();
      setPlaying(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, total]);

  const step = (delta: number) => {
    if (!total) return;
    setPlaying(false);
    setIndex((i) => (i + delta + total) % total);
  };

  const lines = current?.lines ?? [];
  const where =
    lines.length > 1
      ? t("review.previewLines", { from: lines[0], to: lines[lines.length - 1] })
      : lines.length === 1
        ? t("review.previewLine", { n: lines[0] })
        : null;

  return (
    <SatrDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-3.5 bg-deep px-5 py-4 text-on-deep">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <DialogPrimitive.Title className="m-0 font-display text-[22px] font-semibold leading-tight">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="m-0 text-[13px] text-on-deep-2">
            {t("review.previewHint")}
          </DialogPrimitive.Description>
        </div>
        <SatrDialogClose className="bg-white/10 text-on-deep hover:bg-white/20 hover:text-on-deep" />
      </div>

      {total === 0 || !current || !natural ? (
        <p className="m-0 px-5 py-12 text-center text-[13px] text-ink-3">
          {t("review.previewEmpty")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex justify-center bg-well px-5 py-[22px]">
            {/* Shrink-wraps the image, so the overlay's percentages line up with
                the rendered page at any size. The scan stays on white. */}
            <div className="relative inline-block bg-white shadow-[0_10px_28px_rgba(0,0,0,0.18)]">
              <img
                src={imageUrl}
                alt={title}
                className="block max-h-[56vh] max-w-full select-none"
                draggable={false}
              />
              {current.rects.map((r, i) => (
                <span
                  key={i}
                  // `multiply` keeps the ink readable through the tint — a
                  // highlighter over paper, which is what the app does.
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
          </div>

          <div className="flex flex-col gap-3.5 px-[22px] pb-5 pt-4">
            {/* Where the run is: done in lapis, the lit aya gold. */}
            <div className="flex items-center gap-1" aria-hidden="true">
              {ayat.map((a, i) => (
                <span
                  key={a.key}
                  className={`h-1.5 flex-1 rounded-[3px] ${
                    i < safeIndex ? "bg-lapis" : i === safeIndex ? "bg-gold" : "bg-sunk"
                  }`}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3.5">
              <div className="flex min-w-[170px] flex-col gap-0.5">
                <span className="font-display text-[20px] font-semibold leading-tight">
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
              </div>

              <div className="flex flex-1 items-center justify-center gap-2.5" dir="ltr">
                <Round title={t("review.previewPrev")} onClick={() => step(-1)}>
                  <ChevronLeft size={18} aria-hidden="true" />
                </Round>
                <button
                  type="button"
                  title={playing ? t("review.previewPause") : t("review.previewPlay")}
                  aria-label={playing ? t("review.previewPause") : t("review.previewPlay")}
                  onClick={() => setPlaying((p) => !p)}
                  className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-lapis text-on-lapis transition-colors hover:bg-lapis/90"
                >
                  {playing ? (
                    <Pause size={20} aria-hidden="true" />
                  ) : (
                    <Play size={20} aria-hidden="true" />
                  )}
                </button>
                <Round title={t("review.previewNext")} onClick={() => step(1)}>
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
            </div>
          </div>
        </div>
      )}
    </SatrDialogFrame>
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

import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AyaGroup } from "@/lib/review/recompute";

/** Milliseconds each aya stays highlighted, per speed setting. */
const SPEEDS = { slow: 2500, normal: 1300, fast: 650 } as const;
type Speed = keyof typeof SPEEDS;

/**
 * Plays the page's cuts back the way a mushaf app would: the page image with
 * exactly one aya highlighted at a time, stepping on a timer or by hand. It
 * reads the LIVE derived ayat, so it previews the edits in the session — this
 * is the fastest way to tell whether the separators actually landed right.
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-text-primary">{title}</DialogTitle>
        </DialogHeader>

        {total === 0 || !current || !natural ? (
          <p className="py-10 text-center text-[12.5px] text-text-muted">
            {t("review.previewEmpty")}
          </p>
        ) : (
          <>
            <div className="flex justify-center">
              {/* Shrink-wraps the image, so the overlay's percentages line up
                  with the rendered page at any size. */}
              <div className="relative inline-block bg-white">
                <img
                  src={imageUrl}
                  alt={title}
                  className="block max-h-[62vh] max-w-full select-none"
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
                      background: "color-mix(in oklab, var(--orange) 42%, white)",
                      boxShadow: "inset 0 0 0 1.5px var(--orange)",
                      mixBlendMode: "multiply",
                      borderRadius: 2,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-text-primary">
                  {t("review.previewAya", {
                    sura: suraName(current.sura),
                    aya: current.aya,
                  })}
                </div>
                <div className="text-[11.5px] text-text-muted">
                  {t("review.previewPosition", { index: safeIndex + 1, total })}
                </div>
              </div>

              <div className="flex gap-4" dir="ltr">
                <Round title={t("review.previewPrev")} onClick={() => step(-1)}>
                  <ChevronLeft size={16} />
                </Round>
                <Round
                  title={playing ? t("review.previewPause") : t("review.previewPlay")}
                  onClick={() => setPlaying((p) => !p)}
                  accent
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </Round>
                <Round title={t("review.previewNext")} onClick={() => step(1)}>
                  <ChevronRight size={16} />
                </Round>
              </div>

              <div className="flex items-center gap-2">
                <div className="ms-1 flex overflow-hidden rounded-sm border border-border-strong">
                  {(Object.keys(SPEEDS) as Speed[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSpeed(s)}
                      className={`h-8 cursor-pointer px-2.5 text-[11px] font-semibold transition-colors ${
                        speed === s
                          ? "bg-navy text-white"
                          : "bg-white text-text-secondary hover:bg-bg-surface"
                      }`}
                    >
                      {t(`review.previewSpeed_${s}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Round({
  title,
  onClick,
  accent,
  children,
}: {
  title: string;
  onClick: () => void;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border transition-colors ${
        accent
          ? "border-orange bg-orange text-white hover:bg-orange-hover"
          : "border-border-strong bg-white text-text-secondary hover:bg-bg-surface"
      }`}
    >
      {children}
    </button>
  );
}

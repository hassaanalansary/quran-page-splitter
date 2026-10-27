import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SatrDialogClose, SatrDialogFrame } from "@/components/app/SatrDialog";

export type ExportedLine = { line_number: number; src: string };

type Bg = "white" | "dark" | "checker";

/** The backdrops, fixed like the canvas' own: the grid is a dot every 16 px on
 * white. */
const BACKDROP: Record<Bg, string> = {
  white: "bg-white",
  dark: "bg-[#0b0b0b]",
  checker:
    "bg-white bg-[radial-gradient(#cfc3ae_1px,transparent_1px)] bg-[length:16px_16px] bg-[position:8px_8px]",
};

/**
 * Full-size look at one exported line PNG, in a dialog rather than a new tab so
 * the page you were working on stays put. The backdrop switch is the point: a
 * transparent cut only proves itself against light AND dark.
 */
export function ExportedLineDialog({
  lines,
  current,
  onCurrentChange,
}: {
  lines: ExportedLine[];
  /** Line number to show, or null when closed. */
  current: number | null;
  onCurrentChange: (n: number | null) => void;
}) {
  const { t } = useTranslation();
  const [bg, setBg] = useState<Bg>("checker");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const index = lines.findIndex((l) => l.line_number === current);
  const line = index >= 0 ? lines[index] : null;
  const prev = index > 0 ? lines[index - 1] : null;
  const next = index >= 0 && index < lines.length - 1 ? lines[index + 1] : null;
  const file = line ? decodeURIComponent(line.src.split("?")[0].split("/").pop() ?? "") : "";

  useEffect(() => setSize(null), [line?.src]);

  // ↑/↓ walk the exported lines without leaving the dialog.
  useEffect(() => {
    if (!line) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (e.key === "ArrowUp" && prev) onCurrentChange(prev.line_number);
      else if (e.key === "ArrowDown" && next) onCurrentChange(next.line_number);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [line, prev, next, onCurrentChange]);

  const step =
    "inline-flex h-9 flex-none cursor-pointer items-center gap-1.5 rounded-control border border-rule-2 bg-card px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-sheet disabled:cursor-default disabled:opacity-40";

  return (
    <SatrDialogFrame
      open={line != null}
      onOpenChange={(open) => !open && onCurrentChange(null)}
      width={820}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex flex-wrap items-center gap-2.5 px-5 py-3.5">
        <DialogPrimitive.Title className="m-0 font-display text-[20px] font-semibold leading-tight">
          {t("finalize.viewerTitle", { n: line?.line_number ?? 0 })}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description
          dir="ltr"
          className="m-0 ms-auto font-mono text-[12px] text-ink-3"
        >
          {size ? `${file} · ${size.w} × ${size.h}` : file}
        </DialogPrimitive.Description>
        <SatrDialogClose />
      </div>

      {line && (
        <>
          <div
            className={`mx-5 flex min-h-[120px] items-center justify-center rounded-lg border border-rule p-4 ${BACKDROP[bg]}`}
          >
            <img
              src={line.src}
              alt={t("finalize.lineAlt", { n: line.line_number })}
              onLoad={(e) =>
                setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              // The dark backdrop recolours the ink white (alpha preserved), the
              // same trick the canvas uses — dark ink on black is invisible.
              style={bg === "dark" ? { filter: "brightness(0) invert(1)" } : undefined}
              className="max-h-[52vh] max-w-full object-contain"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <button
              type="button"
              disabled={!prev}
              onClick={() => prev && onCurrentChange(prev.line_number)}
              className={step}
            >
              <ChevronLeft size={15} className="rtl:rotate-180" aria-hidden="true" />
              {t("review.lineN", { n: prev?.line_number ?? line.line_number - 1 })}
            </button>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <span className="text-[12.5px] text-ink-3">{t(`finalize.viewerOn_${bg}`)}</span>
              <div
                role="group"
                aria-label={t("canvas.bgTitle")}
                className="inline-flex rounded-lg bg-sunk p-[3px]"
              >
                {(["white", "dark", "checker"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={bg === value}
                    onClick={() => setBg(value)}
                    className={`h-7 cursor-pointer rounded-control px-2.5 text-[12.5px] transition-colors ${
                      bg === value
                        ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                        : "font-medium text-ink-2 hover:text-ink"
                    }`}
                  >
                    {t(value === "checker" ? "canvas.bg_grid" : `canvas.bg_${value}`)}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              disabled={!next}
              onClick={() => next && onCurrentChange(next.line_number)}
              className={step}
            >
              {t("review.lineN", { n: next?.line_number ?? line.line_number + 1 })}
              <ChevronRight size={15} className="rtl:rotate-180" aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </SatrDialogFrame>
  );
}

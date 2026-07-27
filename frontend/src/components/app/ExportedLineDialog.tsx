import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type ExportedLine = { line_number: number; src: string };

type Bg = "white" | "dark" | "checker";

/** Checkerboard that reads as "transparent", matching the canvas' grid mode. */
const CHECKER =
  "bg-[repeating-conic-gradient(#e2e2e2_0_25%,transparent_0_50%)] bg-[length:16px_16px] bg-white";

/**
 * Full-size look at one exported line PNG, in a dialog rather than a new tab so
 * the page you were working on stays put. The background switch is the point:
 * a transparent cut only proves itself against light AND dark.
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

  const index = lines.findIndex((l) => l.line_number === current);
  const line = index >= 0 ? lines[index] : null;

  // ↑/↓ walk the exported lines without leaving the dialog.
  useEffect(() => {
    if (!line) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (e.key === "ArrowUp" && index > 0) onCurrentChange(lines[index - 1].line_number);
      else if (e.key === "ArrowDown" && index < lines.length - 1)
        onCurrentChange(lines[index + 1].line_number);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [line, index, lines, onCurrentChange]);

  return (
    <Dialog open={line != null} onOpenChange={(open) => !open && onCurrentChange(null)}>
      <DialogContent className="max-w-3xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-text-primary">
            {t("finalize.viewerTitle", { n: line?.line_number ?? 0 })}
          </DialogTitle>
        </DialogHeader>

        {line && (
          <>
            <div
              className={`flex items-center justify-center rounded-md border border-border ${
                bg === "white" ? "bg-white" : bg === "dark" ? "bg-[#0b0b0b]" : CHECKER
              }`}
            >
              <img
                src={line.src}
                alt={t("finalize.lineAlt", { n: line.line_number })}
                // Dark mode recolours the ink white (alpha preserved), the same
                // trick the finalize canvas uses — dark ink on black is invisible.
                style={bg === "dark" ? { filter: "brightness(0) invert(1)" } : undefined}
                className="max-h-[52vh] max-w-full object-contain"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Step
                  title={t("review.prevLine")}
                  disabled={index <= 0}
                  onClick={() => onCurrentChange(lines[index - 1].line_number)}
                >
                  <ChevronUp size={16} />
                </Step>
                <span className="text-[11.5px] text-text-muted">
                  {t("review.linePosition", { n: line.line_number, total: lines.length })}
                </span>
                <Step
                  title={t("review.nextLine")}
                  disabled={index >= lines.length - 1}
                  onClick={() => onCurrentChange(lines[index + 1].line_number)}
                >
                  <ChevronDown size={16} />
                </Step>
              </div>

              <div className="flex overflow-hidden rounded-sm border border-border-strong">
                {(["white", "dark", "checker"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setBg(value)}
                    className={`h-8 cursor-pointer px-2.5 text-[11px] font-semibold transition-colors ${
                      bg === value
                        ? "bg-navy text-white"
                        : "bg-white text-text-secondary hover:bg-bg-surface"
                    }`}
                  >
                    {t(value === "checker" ? "canvas.bg_grid" : `canvas.bg_${value}`)}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Step({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-border-strong bg-white text-text-secondary transition-colors hover:bg-bg-surface disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

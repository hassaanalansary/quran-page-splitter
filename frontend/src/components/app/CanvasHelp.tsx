import { Check, HelpCircle, Lightbulb, RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type GuideItem = { label: string; done?: boolean };

const ICON_BTN =
  "flex h-8 w-8 items-center justify-center rounded-full cursor-pointer border border-border-strong bg-white/95 text-orange shadow-md backdrop-blur-sm transition-colors hover:bg-bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500";

/**
 * A compact help cluster pinned to the top-start corner of a canvas (top-left in
 * LTR, top-right in RTL). A "?" opens the step guide as a modal; a lightbulb
 * shows the step's key gesture. Hover explains the control's purpose; click
 * expands the hint inline, and clicking again collapses it.
 */
export function CanvasHelp({
  guideItems,
  guideAbout,
  coachText,
  onReplayTour,
}: {
  guideItems: GuideItem[];
  /** Overrides the intro line — e.g. for steps whose list is plain instructions
   * rather than a checklist that ticks off. */
  guideAbout?: string;
  coachText: string;
  onReplayTour?: () => void;
}) {
  return (
    <div className="absolute top-10 start-3 z-20 flex items-center gap-1.5">
      <GuideDialog items={guideItems} about={guideAbout} onReplayTour={onReplayTour} />
      <Coach text={coachText} />
    </div>
  );
}

function GuideDialog({
  items,
  about,
  onReplayTour,
}: {
  items: GuideItem[];
  about?: string;
  onReplayTour?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <button type="button" aria-label={t("guide.title")} className={ICON_BTN}>
                <HelpCircle size={16} />
              </button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px] text-start leading-snug">
            {t("guide.title")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="max-w-md" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-text-primary">{t("guide.title")}</DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-text-secondary">{about ?? t("guide.about")}</p>
        <ol className="flex flex-col gap-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[13px] leading-[1.5]">
              <span
                className={`mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[10px] font-semibold ${
                  item.done
                    ? "border-success bg-success text-white"
                    : "border-border-strong text-text-muted"
                }`}
              >
                {item.done ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className={item.done ? "text-text-muted line-through" : "text-text-secondary"}>
                {item.label}
              </span>
            </li>
          ))}
        </ol>
        {onReplayTour && (
          <div className="flex justify-end border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                onReplayTour();
              }}
            >
              <RotateCcw size={13} /> {t("guide.replayTour")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Coach({ text }: { text: string }) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLSpanElement>(null);
  const [contentWidth, setContentWidth] = useState(32);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const width = contentRef.current?.scrollWidth;
    if (width) setContentWidth(Math.ceil(width + 2));
  }, [text]);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={open ? t("coach.collapse") : t("coach.show")}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            style={{ maxWidth: open ? contentWidth : 32 }}
            className="inline-flex h-8 min-w-0 shrink-0 cursor-pointer items-center overflow-hidden rounded-full border border-border-strong bg-white/95 text-orange shadow-md backdrop-blur-sm transition-[max-width,background-color,color] duration-200 ease-out hover:bg-bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <span ref={contentRef} className="flex h-full w-max min-w-max items-center gap-2 px-2">
              <Lightbulb size={16} className="flex-none" />
              <span
                aria-hidden={!open}
                className="whitespace-nowrap text-start text-[12px] leading-snug text-text-secondary"
              >
                {text}
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[220px] text-start leading-snug">
          {open ? t("coach.collapse") : t("coach.goal")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

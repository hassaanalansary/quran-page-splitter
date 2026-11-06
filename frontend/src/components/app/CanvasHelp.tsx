import * as DialogPrimitive from "@radix-ui/react-dialog";
import { HelpCircle, Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { DIALOG_PRIMARY, SatrDialogClose, SatrDialogFrame } from "@/components/app/SatrDialog";
import { PHASES, useShellStep } from "@/components/app/shell/context";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { OPEN_GUIDE_EVENT } from "@/lib/guide";
import { readFlag, writeFlag } from "@/lib/prefs";
import { cn } from "@/lib/utils";

const ICON_BTN =
  "flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-full border border-rule-2 bg-card/95 text-lapis-text shadow-[var(--shadow-card)] backdrop-blur-sm transition-colors hover:bg-sheet focus:outline-none focus-visible:ring-2 focus-visible:ring-lapis";

/**
 * The step's help, pinned to the top-start corner of its canvas (top-left in LTR,
 * top-right in RTL): a "?" that opens the step guide — which the spine's "How
 * this step works" opens too — and the coach hint, the step's key gesture in a
 * dark pill until it is hidden. A lightbulb brings a hidden hint back.
 */
export function CanvasHelp({
  guideItems,
  coachText,
  onReplayTour,
  className,
}: {
  /** What this step asks of you, in order — plain instructions, never ticked
   * off: every step here is something you keep coming back to. */
  guideItems: string[];
  coachText: string;
  onReplayTour?: () => void;
  /** Moves the cluster, for a canvas whose toolbar is taller (Ink). */
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute start-4 top-[68px] z-20 flex max-w-[calc(100%-32px)] items-start gap-1.5",
        className,
      )}
    >
      <GuideDialog items={guideItems} onReplayTour={onReplayTour} />
      <Coach text={coachText} />
    </div>
  );
}

function GuideDialog({ items, onReplayTour }: { items: string[]; onReplayTour?: () => void }) {
  const { t } = useTranslation();
  const step = useShellStep();
  const [open, setOpen] = useState(false);
  const number = step ? PHASES.flatMap((phase) => phase.steps).indexOf(step) + 1 : 0;

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_GUIDE_EVENT, show);
    return () => window.removeEventListener(OPEN_GUIDE_EVENT, show);
  }, []);

  return (
    <>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("guide.title")}
              onClick={() => setOpen(true)}
              className={`${ICON_BTN} pointer-events-auto`}
            >
              <HelpCircle size={16} aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px] text-start">
            {t("guide.title")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <SatrDialogFrame
        open={open}
        onOpenChange={setOpen}
        width={460}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-start gap-3 bg-deep px-5 py-[18px] text-on-deep">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {step && (
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-on-deep-2">
                {t("guide.stepEyebrow", { n: number, name: t(`header.steps.${step}`) })}
              </span>
            )}
            <DialogPrimitive.Title className="m-0 font-display text-[22px] font-semibold leading-tight">
              {t("guide.title")}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              {t("guide.title")}
            </DialogPrimitive.Description>
          </div>
          <SatrDialogClose className="bg-white/10 text-on-deep hover:bg-white/20 hover:text-on-deep" />
        </div>
        <ol className="m-0 flex min-h-0 flex-1 list-none flex-col gap-3.5 overflow-y-auto px-5 py-4">
          {items.map((label, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-lapis-wash text-[12.5px] font-bold text-lapis-text">
                {i + 1}
              </span>
              <span className="text-[13.5px] leading-[1.55] text-ink-2">{label}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-none items-center justify-between gap-3 border-t border-rule-soft bg-sheet px-5 py-3">
          {onReplayTour ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onReplayTour();
              }}
              className="h-[38px] cursor-pointer px-1 text-[13.5px] font-semibold text-lapis-text hover:underline"
            >
              {t("guide.replayTour")}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={cn(DIALOG_PRIMARY, "h-[38px] px-4 text-[13.5px]")}
          >
            {t("guide.gotIt")}
          </button>
        </div>
      </SatrDialogFrame>
    </>
  );
}

/** The step's key gesture in the dark pill. Hiding it is remembered per step; the
 * lightbulb shows it again. */
function Coach({ text }: { text: string }) {
  const { t } = useTranslation();
  const step = useShellStep();
  const key = `qps.coach.hidden.${step ?? "page"}`;
  const [hidden, setHidden] = useState(() => readFlag(key));

  const hide = (value: boolean) => {
    setHidden(value);
    writeFlag(key, value);
  };

  if (hidden) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("coach.show")}
              onClick={() => hide(false)}
              className={`${ICON_BTN} pointer-events-auto`}
            >
              <Lightbulb size={16} aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px] text-start">
            {t("coach.goal")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div
      role="note"
      className="pointer-events-auto flex min-w-0 max-w-[440px] items-center gap-2.5 rounded-card bg-toast py-1.5 pe-1.5 ps-3 text-[12.5px] leading-snug text-on-toast shadow-[var(--shadow-card)]"
    >
      <span className="min-w-0 flex-1">{text}</span>
      <button
        type="button"
        onClick={() => hide(true)}
        aria-label={t("coach.collapse")}
        className="h-[26px] flex-none cursor-pointer rounded-[5px] bg-on-toast/10 px-2 text-[12px] font-semibold transition-colors hover:bg-on-toast/20"
      >
        {t("coach.hide")}
      </button>
    </div>
  );
}

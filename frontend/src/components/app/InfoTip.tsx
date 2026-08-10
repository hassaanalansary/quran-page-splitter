import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** A small "(i)" affordance that explains what an input means / a typical value.
 * Self-contained: ships its own TooltipProvider (there is no global one). */
export function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            onClick={(e) => e.preventDefault()}
            className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-text-muted transition-colors hover:text-orange focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <Info size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px] text-start leading-snug">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

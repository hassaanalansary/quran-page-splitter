import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** A small "i" in a lapis ring that explains what an input means or a typical
 * value, in a tooltip in the toast's inverse colours. Self-contained: ships its
 * own TooltipProvider (there is no global one). */
export function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            onClick={(e) => e.preventDefault()}
            className="ms-auto inline-flex h-[18px] w-[18px] flex-none cursor-help items-center justify-center rounded-full border-[1.5px] border-lapis bg-lapis-wash font-sans text-[10.5px] font-bold leading-none text-lapis-text transition-colors hover:bg-lapis hover:text-on-lapis focus:outline-none focus-visible:ring-2 focus-visible:ring-lapis"
          >
            <span aria-hidden="true">i</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px] text-start leading-snug">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

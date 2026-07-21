import { Lightbulb, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { readFlag, writeFlag } from "@/lib/prefs";

/** A dismissible hint chip floated over a canvas, surfacing the step's primary
 * gesture right where it happens. Render inside a `relative` wrapper around the
 * canvas. Dismissal is remembered per step. */
export function CanvasCoach({ storageKey, text }: { storageKey: string; text: string }) {
  const { t } = useTranslation();
  const key = `coach:${storageKey}:dismissed`;
  const [dismissed, setDismissed] = useState(() => readFlag(key));
  if (dismissed) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-[92%] items-center gap-2 rounded-full border border-border-strong bg-white/95 px-3 py-1.5 text-[12px] text-text-secondary shadow-md backdrop-blur-sm">
        <Lightbulb size={14} className="flex-none text-orange" />
        <span className="leading-snug">{text}</span>
        <button
          type="button"
          aria-label={t("coach.dismiss")}
          onClick={() => {
            writeFlag(key, true);
            setDismissed(true);
          }}
          className="flex-none rounded-full p-0.5 text-text-muted transition-colors hover:bg-bg-surface hover:text-text-primary"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

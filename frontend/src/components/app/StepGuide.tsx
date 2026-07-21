import { Check, ChevronDown, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { readFlag, writeFlag } from "@/lib/prefs";

export type GuideItem = { label: string; done?: boolean };

/** A collapsible "How this works" checklist for the top of a step's control
 * panel. Items tick green as their sub-task is completed (live `done` flags).
 * Collapsed state is remembered per step so power users can keep it closed. */
export function StepGuide({
  items,
  storageKey,
  onReplayTour,
}: {
  items: GuideItem[];
  storageKey: string;
  onReplayTour?: () => void;
}) {
  const { t } = useTranslation();
  const key = `guide:${storageKey}:collapsed`;
  const [collapsed, setCollapsed] = useState(() => readFlag(key));
  const doneCount = items.filter((i) => i.done).length;

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      writeFlag(key, next);
      return next;
    });
  }

  return (
    <div className="rounded-md border border-border bg-bg-surface">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-1"
      >
        <ChevronDown
          size={14}
          className={`flex-shrink-0 text-text-muted transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        <span className="flex-1 text-start text-[12px] font-semibold tracking-[0.02em] text-text-primary">
          {t("guide.title")}
        </span>
        <span className="font-mono text-[10.5px] text-text-muted">
          {doneCount}/{items.length}
        </span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          <ol className="flex flex-col gap-1.5">
            {items.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-[1.45]">
                <span
                  className={`mt-[1px] flex h-4 w-4 flex-none items-center justify-center rounded-full border text-[9px] font-semibold ${
                    item.done
                      ? "border-success bg-success text-white"
                      : "border-border-strong text-text-muted"
                  }`}
                >
                  {item.done ? <Check size={11} strokeWidth={3} /> : i + 1}
                </span>
                <span
                  className={item.done ? "text-text-muted line-through" : "text-text-secondary"}
                >
                  {item.label}
                </span>
              </li>
            ))}
          </ol>

          {onReplayTour && (
            <button
              type="button"
              onClick={onReplayTour}
              className="flex items-center gap-1 self-start text-[11px] font-medium text-orange hover:underline"
            >
              <RotateCcw size={12} /> {t("guide.replayTour")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

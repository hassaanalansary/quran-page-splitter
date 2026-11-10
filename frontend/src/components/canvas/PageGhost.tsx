import { useTranslation } from "react-i18next";

import { SatrLoader } from "@/components/app/SatrLoader";

const LINES = 12;

/**
 * A page while its image renders: a faint page of lines with the writing loader
 * over it, so the canvas keeps its shape. The page colours stay light in both
 * themes, as a scan does.
 */
export function PageGhost({ label, detail }: { label?: string; detail?: string }) {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <div className="relative flex h-[214px] w-[150px] flex-col justify-between rounded bg-page px-4 py-6 opacity-90 shadow-[0_2px_10px_rgba(0,0,0,0.12)]">
        {Array.from({ length: LINES }, (_, i) => (
          <span key={i} className="h-[5px] rounded-[3px] bg-[#e6ded0]" />
        ))}
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded bg-[rgba(255,253,248,0.7)] px-3 text-center"
        >
          <SatrLoader className="w-16 text-[color:var(--satr-ink)]" />
          <span className="text-[13px] font-semibold text-[color:var(--satr-ink)]">
            {label ?? t("canvas.fin_rendering")}
          </span>
          {detail && (
            <span className="font-mono text-[11px] text-[color:var(--ov-text-quiet)]">
              {detail}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

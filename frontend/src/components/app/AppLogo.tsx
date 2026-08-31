import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/** The brand lockup: the Cascade mark beside the app name.
 *
 * The mark reads as one rule halved and then quartered — page, line, aya, word —
 * with exactly one orange bar standing for the segment just detected. It ships as
 * a static SVG rather than inline JSX so the same file serves the favicon, README
 * and any social card without a second copy drifting out of step.
 *
 * Two rules from the brand sheet are enforced here rather than left to callers:
 * the mark never renders below 16px (below that the design calls for the favicon
 * lockup instead), and in RTL it mirrors so the ragged edge follows the text.
 */
export function AppLogo({ size = 16, className }: { size?: number; className?: string }) {
  const { t } = useTranslation();

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src="/logo-mark.svg"
        alt=""
        width={size}
        height={size}
        // Decorative: the app name sits right beside it, so announcing the mark
        // as well would read the brand twice.
        aria-hidden="true"
        className="rtl:-scale-x-100"
      />
      <span className="font-display text-[15px] font-bold leading-none text-navy">
        {t("common.appName")}
      </span>
    </div>
  );
}

import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/**
 * The SATR header lockup: the small tile and the drawn wordmark
 * (design/brand/satr/logo/satr-lockup-horizontal-small-*.svg), split in two so the
 * pair can follow the reading direction. The mark itself is never mirrored: it is
 * Arabic writing, and SVG drawing ignores `dir`. Only the order of tile and wordmark
 * flips under RTL. The tile is the same in both themes; the wordmark is
 * `currentColor` (ink by default). Keep it at least 24 px tall.
 */
export function SatrLockup({ height = 28, className }: { height?: number; className?: string }) {
  const { t } = useTranslation();

  return (
    <span
      role="img"
      aria-label={t("common.appName")}
      className={cn("inline-flex flex-none items-center text-ink", className)}
      style={{ height, gap: height * 0.24 }}
    >
      <svg viewBox="0 0 32 32" className="h-full w-auto" aria-hidden="true">
        <rect width="32" height="32" rx="7.16" fill="#173E70" />
        <rect y="20.29" width="32" height="1.12" fill="#C9962E" />
        <g transform="translate(4.63 20.85) scale(0.2048)">
          <g
            fill="none"
            stroke="#F4EFE6"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M112 -20 L112 0 L20 0 C10 0 4 10 -1 24" />
            <path d="M92 -20 L92 0" />
            <path d="M72 -20 L72 0" />
            <path d="M52 0 L52 -20 Q52 -28 44 -28 L28 -28" />
            <path d="M28 0 L28 -62" />
          </g>
        </g>
      </svg>
      <svg viewBox="39.68 0 48.38 32" className="h-full w-auto" aria-hidden="true">
        <g transform="translate(39.68 21.76) scale(0.288)">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M30 -36 L14 -36 Q4 -36 4 -26 Q4 -20 14 -20 L20 -20 Q30 -20 30 -10 Q30 -4 20 -4 L4 -4" />
            <path d="M50 -4 L50 -26 Q50 -36 60 -36 L66 -36 Q76 -36 76 -26 L76 -4" />
            <path d="M50 -18 L76 -18" />
            <path d="M93 -36 L121 -36" />
            <path d="M107 -36 L107 -4" />
            <path d="M138 -4 L138 -36 L154 -36 Q164 -36 164 -26 Q164 -20 154 -20 L138 -20" />
            <path d="M151 -20 L164 -4" />
          </g>
        </g>
      </svg>
    </span>
  );
}

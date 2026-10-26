import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import {
  SATR_FATHA,
  SATR_LETTERS,
  SATR_LETTERS_SMALL,
  SATR_STAR,
  SATR_SUKUN,
  SATR_TILE,
  SATR_TILE_GOLD,
  SATR_TILE_INK,
  SATR_TILE_MARK,
  SATR_WORDMARK,
} from "./satrMark";

/**
 * The SATR lockup: the tile and the drawn wordmark, in the proportions the redesign
 * boards use (the wordmark 0.48 of the tile's height, a third of it between them).
 * The mark is never mirrored: it is Arabic writing, and SVG drawing ignores `dir`.
 * Only the order of tile and wordmark flips under RTL. The tile is the same in both
 * themes; the wordmark is `currentColor` (ink by default). Keep it at least 24 px.
 */
export function SatrLockup({ size = 28, className }: { size?: number; className?: string }) {
  const { t } = useTranslation();

  return (
    <span
      role="img"
      aria-label={t("common.appName")}
      className={cn("inline-flex flex-none items-center text-ink", className)}
      style={{ gap: size / 3 }}
    >
      {size >= 64 ? <SatrSymbol size={size} /> : <SatrTile size={size} />}
      <SatrWordmark height={size * 0.48} />
    </span>
  );
}

/** The tile below 64 px: the heavier word, no marks. */
export function SatrTile({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="flex-none">
      <rect width="64" height="64" rx="14.32" fill={SATR_TILE} />
      <rect y="40.58" width="64" height="2.24" fill={SATR_TILE_GOLD} />
      <g transform="translate(9.27 41.7) scale(0.4096)">
        <g
          fill="none"
          stroke={SATR_TILE_INK}
          strokeWidth="12"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {SATR_LETTERS_SMALL.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </g>
    </svg>
  );
}

/** The full symbol, from 64 px: the word with its fatha and sukun, and ۞. */
export function SatrSymbol({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="flex-none">
      <rect width="64" height="64" rx="14.32" fill={SATR_TILE} />
      <rect y="39.64" width="64" height="0.7" fill={SATR_TILE_GOLD} />
      <g transform="translate(8.01 39.99) scale(0.3058)">
        <g
          fill="none"
          stroke={SATR_TILE_INK}
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {SATR_LETTERS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <path
          d={SATR_FATHA}
          fill="none"
          stroke={SATR_TILE_MARK}
          strokeWidth="5.5"
          strokeLinecap="round"
        />
        <path d={SATR_SUKUN} fill={SATR_TILE_MARK} />
        <polygon points={SATR_STAR} fill={SATR_TILE_GOLD} />
      </g>
    </svg>
  );
}

/** "SATR", drawn, in `currentColor`. */
export function SatrWordmark({ height, className }: { height: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 168 40"
      height={height}
      width={height * 4.2}
      aria-hidden="true"
      className={cn("flex-none", className)}
    >
      <g
        transform="translate(0 40)"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {SATR_WORDMARK.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** The word alone, every part in `currentColor`: a watermark behind a deep panel. */
export function SatrGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 154.87 102" aria-hidden="true" className={cn("block", className)}>
      <g transform="translate(-1 74)">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {SATR_LETTERS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <path
          d={SATR_FATHA}
          fill="none"
          stroke="currentColor"
          strokeWidth="5.5"
          strokeLinecap="round"
        />
        <path d={SATR_SUKUN} fill="currentColor" />
        <polygon points={SATR_STAR} fill="currentColor" />
      </g>
    </svg>
  );
}

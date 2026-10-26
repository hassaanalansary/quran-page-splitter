import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * The SATR loaders (design/brand/satr/loader/*-currentcolor.svg), inline so the
 * theme reaches them: the letters take `color`, the rest the --satr-* tokens. Their
 * animation lives in styles.css (.satr-ld-*, .satr-li-*). Both are decoration: the
 * wait's own words sit beside them.
 */

/** The writing loader, for a page or canvas that is still loading. */
export function SatrLoader({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 166.87 114"
      aria-hidden="true"
      className={cn("h-auto w-24 flex-none text-ink", className)}
    >
      <g className="satr-ld-all" transform="translate(5 80)">
        <rect
          className="satr-ld-rule"
          x="-5"
          y="-1.1"
          width="166.87"
          height="2.2"
          fill="var(--satr-gold)"
        />
        <g
          className="satr-ld-word"
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path className="satr-ld-s0" pathLength={1} d="M112 -20 L112 0 L26 0 C16 0 10 10 5 24" />
          <path className="satr-ld-s1" pathLength={1} d="M94 -20 L94 0" />
          <path className="satr-ld-s2" pathLength={1} d="M76 -20 L76 0" />
          <path className="satr-ld-s3" pathLength={1} d="M58 0 L58 -20 Q58 -28 50 -28 L34 -28" />
          <path className="satr-ld-s4" pathLength={1} d="M34 0 L34 -70" />
        </g>
        <g
          className="satr-ld-mark"
          fill="none"
          stroke="var(--satr-mark)"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path pathLength={1} d="M104 -44 L85 -33" />
        </g>
        <path
          className="satr-ld-sukun"
          fill="var(--satr-mark)"
          d="M67.14 -51.35C66.79 -51.74 66.17 -52.28 65.42 -52.75C64.66 -53.22 63.48 -53.84 62.61 -54.15C61.73 -54.47 60.91 -54.39 60.16 -54.62C59.42 -54.86 59.26 -55.41 58.13 -55.56C57.01 -55.71 55.04 -55.97 53.4 -55.51C51.76 -55.05 49.41 -53.5 48.3 -52.8C47.19 -52.11 47.31 -52.09 46.74 -51.35C46.17 -50.6 45.24 -49.13 44.86 -48.33C44.49 -47.52 44.54 -47.06 44.5 -46.51C44.46 -45.95 44.48 -45.41 44.6 -45C44.73 -44.58 44.97 -44.19 45.23 -44.01C45.49 -43.83 45.63 -43.76 46.17 -43.9C46.7 -44.05 47.6 -44.4 48.45 -44.89C49.31 -45.39 50.55 -46.44 51.32 -46.87C52.08 -47.3 52.56 -47.42 53.03 -47.49C53.51 -47.57 53.87 -47.49 54.18 -47.34C54.49 -47.19 54.81 -46.85 54.91 -46.61C55 -46.37 55.7 -46.59 54.75 -45.88C53.81 -45.17 50.33 -43.15 49.24 -42.34C48.14 -41.54 48.42 -41.45 48.19 -41.04C47.97 -40.63 47.84 -40.26 47.88 -39.9C47.93 -39.53 48.2 -39.1 48.45 -38.86C48.71 -38.61 48.34 -38.5 49.39 -38.44C50.44 -38.38 53.13 -38.13 54.75 -38.49C56.37 -38.86 57.76 -39.87 59.12 -40.63C60.48 -41.38 61.76 -42.14 62.92 -43.02C64.08 -43.9 65.41 -45.16 66.1 -45.88C66.78 -46.6 66.81 -46.87 67.03 -47.34C67.26 -47.81 67.37 -48.18 67.45 -48.69C67.53 -49.2 67.55 -49.97 67.5 -50.41C67.45 -50.85 67.48 -50.95 67.14 -51.35Z"
        />
        <polygon
          className="satr-ld-star"
          fill="var(--satr-gold)"
          points="142.44,-25.44 146.37,-21.5 151.94,-21.5 151.94,-15.94 155.87,-12 151.94,-8.06 151.94,-2.5 146.37,-2.5 142.44,1.44 138.5,-2.5 132.94,-2.5 132.94,-8.06 129,-12 132.94,-15.94 132.94,-21.5 138.5,-21.5"
        />
      </g>
    </svg>
  );
}

/** The inline loader, for a button or a short wait: sized to the text beside it. */
export function SatrLoaderInline({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 24"
      aria-hidden="true"
      className={cn("inline-block h-[1em] w-[2em] flex-none", className)}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 19 H42" />
        <path className="satr-li-tooth" d="M34 19 V6" />
        <path className="satr-li-tooth satr-li-t2" d="M24 19 V6" />
        <path className="satr-li-tooth satr-li-t3" d="M14 19 V6" />
      </g>
      <path
        className="satr-li-fatha"
        d="M30 2.6 L19 6.2"
        fill="none"
        stroke="var(--satr-mark)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A button's waiting label: the inline loader, then the words. */
export function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <SatrLoaderInline />
      {children}
    </span>
  );
}

/** A page or canvas still loading: the writing loader over the words. */
export function LoadingState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-3 text-center", className)}>
      <SatrLoader />
      {children}
    </div>
  );
}

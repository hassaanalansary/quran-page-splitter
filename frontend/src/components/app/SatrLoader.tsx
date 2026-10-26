import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { SATR_FATHA, SATR_LETTERS, SATR_STAR, SATR_SUKUN } from "./satrMark";

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
          {SATR_LETTERS.map((d, i) => (
            <path key={d} className={`satr-ld-s${i}`} pathLength={1} d={d} />
          ))}
        </g>
        <g
          className="satr-ld-mark"
          fill="none"
          stroke="var(--satr-mark)"
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path pathLength={1} d={SATR_FATHA} />
        </g>
        <path className="satr-ld-sukun" fill="var(--satr-mark)" d={SATR_SUKUN} />
        <polygon className="satr-ld-star" fill="var(--satr-gold)" points={SATR_STAR} />
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

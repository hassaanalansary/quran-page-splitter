import { useId } from "react";

import { cn } from "@/lib/utils";

/** The ornament strip: a row of gold ۞ (two squares, one turned 45°), along the
 * top of hero bands, dialog headers and the sign-in panel. */
export function OrnamentStrip({ height = 10, className }: { height?: number; className?: string }) {
  // useId's characters are not all valid in a url(#…) reference.
  const id = `orn${useId().replace(/[^\w-]/g, "")}`;

  return (
    <svg
      width="100%"
      height={height}
      aria-hidden="true"
      className={cn("block flex-none", className)}
    >
      <defs>
        <pattern
          id={id}
          width="14"
          height="10"
          patternUnits="userSpaceOnUse"
          patternTransform={`scale(${height / 10})`}
        >
          <rect x="4.5" y="2.5" width="5" height="5" className="fill-gold" />
          <rect
            x="4.5"
            y="2.5"
            width="5"
            height="5"
            className="fill-gold"
            transform="rotate(45 7 5)"
          />
        </pattern>
      </defs>
      <rect width="100%" height={height} fill={`url(#${id})`} />
    </svg>
  );
}

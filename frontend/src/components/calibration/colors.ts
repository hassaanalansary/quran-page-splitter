import type { BlobRole } from "@/lib/calibration/types";

/** Per-role tint, painted onto each blob's own pixels. Also the legend's colours. */
export const ROLE_RGB: Record<BlobRole, [number, number, number]> = {
  body: [25, 25, 25],
  mark: [40, 180, 200],
  ornament: [150, 80, 160],
  symbol: [190, 120, 20],
};

/** The marks a type filter picks out — a colour no role uses. */
export const HIGHLIGHT_RGB: [number, number, number] = [37, 99, 235];

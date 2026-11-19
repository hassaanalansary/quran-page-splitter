import type { BlobRole } from "@/lib/calibration/types";

/** Per-role tint, painted onto each blob's own pixels. Also the legend's colours. */
export const ROLE_RGB: Record<BlobRole, [number, number, number]> = {
  body: [25, 25, 25],
  mark: [40, 180, 200],
  ornament: [150, 80, 160],
  symbol: [190, 120, 20],
};

/** A mark whose type is not settled: untyped without a sure guess, or typed and
 * doubted by the other pages — painted so it stands out at a glance. A colour no role
 * or highlight uses. */
export const UNSETTLED_RGB: [number, number, number] = [219, 39, 119];

/** The marks a type filter picks out — a colour no role uses. */
export const HIGHLIGHT_RGB: [number, number, number] = [37, 99, 235];

/** The pieces of a body cut with the knife, in piece order (rightmost first): each
 * piece in its own colour, and its word's name on it in the same. Colours no role,
 * highlight or selection uses. */
export const PIECE_RGB: [number, number, number][] = [
  [22, 128, 92],
  [124, 58, 237],
  [180, 83, 9],
  [8, 145, 178],
];

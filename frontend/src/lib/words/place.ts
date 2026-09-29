/** Where on the Words step a location points: its page, and whether it is the cuts
 * editor or calibration. Two locations with the same place show the same editor
 * state; any other move rebuilds it.
 *
 * Read defensively, because a blocker's `search` is the union of every route's
 * schema, and most of them have neither field. */
export function wordsPlace(location: { search: unknown }): string {
  const search = location.search as { page?: unknown; mode?: unknown } | undefined;
  const page = typeof search?.page === "number" ? search.page : "";
  return `${page}:${search?.mode === "calibrate" ? "calibrate" : "cuts"}`;
}

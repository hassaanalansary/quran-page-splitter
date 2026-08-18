// The portable work bundle (schema mushaf-work/v1).
//
// A bundle carries a mushaf's *work* — page bounds, line and segment geometry,
// sura assignments, erase strokes, templates — but not the PDF. It names the
// PDF by sha256 instead, and the server refuses an import unless the target
// mushaf was built from that exact file.

import { API_BASE, apiForm } from "./http";

export interface ImportResult {
  pages_imported: number;
  lines_imported: number;
  source_name: string;
  warnings: {
    bounds_differ: boolean;
    page_count_differs: boolean;
  };
}

/** Download URL for this mushaf's work bundle (an attachment). */
export function bundleUrl(id: string): string {
  return `${API_BASE}/api/mushafs/${id}/bundle`;
}

/**
 * Apply a bundle to a mushaf.
 *
 * `replace` overwrites work already on the target; without it the server
 * answers 409 rather than silently discarding pages.
 */
export function importBundle(id: string, file: File, replace = false): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiForm<ImportResult>("POST", `/api/mushafs/${id}/import?replace=${replace}`, form);
}

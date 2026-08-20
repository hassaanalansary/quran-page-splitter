// The portable work bundle (schema mushaf-work/v1).
//
// A bundle carries a mushaf's *work* — page bounds, line and segment geometry,
// sura assignments, erase strokes, templates — but not the PDF. It names the
// PDF by sha256 instead, and the server refuses an import unless the target
// mushaf was built from that exact file.

import { API_BASE, apiForm } from "./http";
import type { Mushaf } from "./types";

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

/** What a bundle says about itself, read out of its manifest (never the DB). */
export interface BundleSource {
  name: string;
  qiraa: string | null;
  pdf_sha256: string;
  pdf_original_name: string;
  pdf_page_count: number;
  first_quran_pdf_page: number;
  last_quran_pdf_page: number | null;
  exported_at: string;
  pages: number;
  lines: number;
  segments: number;
}

/**
 * One of your mushafs the bundle could go into: built from the same PDF, with
 * its own page counts (what an import would overwrite) and how the bundle's
 * setup diverges from it.
 */
export type BundleMatch = Mushaf & {
  bounds_differ: boolean;
  page_count_differs: boolean;
};

export interface InspectResult {
  bundle: BundleSource;
  matches: BundleMatch[];
}

/**
 * Ask which of your mushafs a bundle belongs to.
 *
 * Reads the manifest only, writes nothing, and is not the last word: the
 * import still re-checks the PDF checksum against whichever match is approved.
 * Zero matches is an ordinary answer — the bundle's PDF isn't in your library.
 */
export function inspectBundle(file: File): Promise<InspectResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiForm<InspectResult>("POST", "/api/bundles/inspect", form);
}

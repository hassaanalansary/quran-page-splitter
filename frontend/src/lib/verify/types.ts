// Editable in-memory model of the upload-pipeline results.json.
// We mirror the backend shape but only keep what the verify UI needs.

import type { Rect } from "@/lib/api/raqam";

export type LineType = "sura_header" | "basmala" | "text";

export type Segment = {
  id: string;
  sura_number: number;
  sura_name: string;
  aya_number: number;
  is_continuation: boolean;
  has_separator: boolean;
  bbox: Rect;
};

export type Line = {
  id: string;
  line_number: number;
  slot_count: number;
  line_bbox: Rect;
  type: LineType;
  /** Only for sura_header lines. */
  sura_number?: number;
  sura_name?: string;
  sura_transliteration?: string;
  /** Only for text lines: x-coordinates of separator cuts inside line_bbox. */
  separator_cuts?: number[];
  /** Only for text lines: derived from separator_cuts + line_bbox. */
  segments?: Segment[];
};

export type Page = {
  id: string;
  page_number: number;
  image_filename: string;
  page_image_filename: string;
  crop_box: Rect;
  lines: Line[];
};

export type Results = {
  exported_at: string;
  start_sura: number;
  start_aya: number;
  end_sura: number;
  end_aya: number;
  pages_processed: number;
  pages: Page[];
};

export function genId(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

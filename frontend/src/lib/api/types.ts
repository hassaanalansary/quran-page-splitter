// TypeScript mirror of the Django Ninja API contract (see backend/api/views/*).
// Bbox fields on lines/segments are FLAT (bbox_x/y/w/h); page/template bounds use
// the nested {x,y,w,h} RectSchema.

export type Rect = { x: number; y: number; w: number; h: number };

// ── Reference data ──────────────────────────────────────────────────────────
export type Sura = {
  number: number;
  name_arabic: string;
  transliteration: string;
  aya_count: number | null;
};

// ── Mushaf ──────────────────────────────────────────────────────────────────
export type Mushaf = {
  id: string;
  name: string;
  qiraa: string | null;
  pdf_page_count: number;
  first_quran_pdf_page: number;
  last_quran_pdf_page: number;
  logical_page_count: number;
  processed_page_count: number;
  reviewed_page_count: number;
  created_at: string;
  updated_at: string;
};

export type MushafStatus = "empty" | "partial" | "processed" | "completed";

/** Derive a coarse pipeline status from a mushaf's page counts. */
export function mushafStatus(m: Mushaf): MushafStatus {
  const total = m.logical_page_count;
  if (m.processed_page_count === 0) return "empty";
  if (total > 0 && m.reviewed_page_count >= total) return "completed";
  if (m.processed_page_count >= total) return "processed";
  return "partial";
}

export type MushafCreateResult = {
  mushaf: Mushaf;
  warnings: { duplicate_file: boolean };
};

export type MushafPatch = Partial<{
  name: string;
  qiraa: string | null;
  first_quran_pdf_page: number;
  last_quran_pdf_page: number;
}>;

// ── Templates ───────────────────────────────────────────────────────────────
export type TemplateType = "sura_header" | "aya_separator";

export type Template = {
  id: string;
  type: TemplateType;
  image_url: string;
  /** `{x,y,w,h}` when an ignore region is set, else `{}`. */
  ignore_rects: Rect | Record<string, never>;
};

// ── Per-page coordinate model (review surface) ──────────────────────────────
export type LineType = "text" | "sura_header" | "besmella";

export type Segment = {
  id?: string;
  segment_order: number;
  bbox_x: number;
  bbox_w: number;
  has_separator: boolean;
  /** Derived server-side; ignored on save. */
  aya_number: number | null;
  /** Echoed from the parent line; ignored on save. */
  sura_number?: number | null;
};

export type Line = {
  id?: string;
  line_number: number;
  type: LineType;
  sura_number: number | null;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  segments: Segment[];
};

export type PageData = {
  page_number: number;
  bbox: Rect | null;
  lines: Line[];
};

export type PageSave = {
  bbox: Rect;
  lines: Line[];
};

// ── Processing ──────────────────────────────────────────────────────────────
export type ProcessSettings = {
  padding: number;
  expected_lines: number;
  sura_header_slots: number;
  sura_header_threshold: number;
  max_sura_headers: number;
  match_threshold: number;
  alternate_horizontal_margin: boolean;
  prefer_acceleration: boolean;
};

export type ProcessRequest = ProcessSettings & {
  page_range_start: number;
  page_range_end: number;
  start_sura: number;
  start_aya: number;
  bounds: Rect;
};

/** One entry of `ProcessResult.results` (engine page dict; shape kept loose). */
export type ProcessPageResult = {
  page_number: number;
  [key: string]: unknown;
};

export type ProcessResult = {
  run_id: string;
  status: "completed" | "aborted_line_detection" | "error" | string;
  pages_processed: number;
  start_sura: number;
  start_aya: number;
  end_sura: number;
  end_aya: number;
  results: ProcessPageResult[];
  abort_info: Record<string, unknown> | null;
};

// ── Finalize + export ───────────────────────────────────────────────────────
export type EraseStroke = {
  brush_size: number;
  /** [x, y] points in source-image (page) pixel space. */
  points: [number, number][];
};

export type FinalizeLine = {
  line_number: number;
  bbox_override: Rect | null;
  erase_strokes: EraseStroke[];
};

export type ExportResult = {
  page_number: number;
  exported: number;
  lines: { line_number: number; line_png: string }[];
};

export const DEFAULT_PROCESS_SETTINGS: ProcessSettings = {
  padding: 4,
  expected_lines: 15,
  sura_header_slots: 1,
  sura_header_threshold: 0.6,
  max_sura_headers: 3,
  match_threshold: 0.5,
  alternate_horizontal_margin: false,
  prefer_acceleration: true,
};

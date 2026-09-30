// The calibration document, exactly as backend/api/services/calibration.py sends it.
//
// EVERYTHING IS IN PAGE PIXELS — blob boxes, word edges, line boxes — the same space
// the served page image and the word cuts live in. A line's `image_url` is that
// line's own crop of the page (its `bbox`), and `labels_url` is a raster the same
// size in which every pixel's blob id is encoded as R + 256·G + 65536·B (0 is
// background): the map clicks are hit-tested against.
import type { PageWords, Rect } from "../api/types";

export type BlobRole = "body" | "mark" | "ornament" | "symbol";
export type TextRole = "body" | "mark";
/** Why a blob is flagged out of the ordinary. "" is none. */
export type BlobException = "" | "mixed" | "broken" | "fused" | "uncertain";
/** Who decided a blob's role: the reviewer, calibration (when locks are on), the
 * text (a small waw or ya it puts on the line), or the alignment search on the frozen
 * scores. */
export type DecisionSource = "human" | "calibration" | "text" | "search";

/** A blob's share of one word. `paws` is 1 for an ordinary letter body, 0 for a
 * broken fragment or for any mark, and 2 or more for bodies printed touching. */
export type Allocation = { word_id: number; paws: number };

/** Calibration's shadow proposal for a blob: what its nearest confirmed examples
 * say, or `role: null` when they do not clear the gate — `reasons` says why. */
export type Proposal = { role?: TextRole | null; confidence?: number; reasons?: string[] };

export type CalibrationBlob = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  /** The frozen engine's evidence that this is a letter body, 0..14. */
  body_score: number;
  role: BlobRole;
  /** What the evidence alone suggested, before any alignment. */
  initial_role: BlobRole;
  /** The reviewer set this role: a hard constraint from now on. */
  explicit: boolean;
  /** The reviewer set these allocations. */
  ownership_explicit: boolean;
  subtype: string;
  /** A person set this type. A stored type without it is a guess that was never
   * accepted — shown as expected, never taught — unless the text set it. */
  subtype_explicit?: boolean;
  /** "text": the type is the one the word's text names for this mark. Typed, and
   * taught once the page is confirmed, but a person's own typing replaces it. */
  subtype_source?: "text";
  /** The text's word on this blob's role: its word's small waw or ya on the line,
   * locked as a mark (provisionally — the reading may release it). */
  text_role?: TextRole;
  /** The word whose small letter the text says this is. */
  text_word?: number;
  exception: BlobException;
  allocations: Allocation[];
  /** Why the blob deserves a look — signals, never verdicts. */
  attention: string[];
  decision_source: DecisionSource;
  proposed_role: TextRole | null;
  proposal: Proposal;
};

export type CalibrationWord = {
  word_id: number | null;
  text: string;
  aya: string;
  expected_paws: number;
  /** The word's RIGHT edge — the larger number; Arabic runs right to left. */
  start_x: number;
  end_x: number;
  /** The edges were dragged by hand; alignment keeps them. */
  override: boolean;
  /** The word shares a blob with a neighbour, printed touching across the break. */
  shared: boolean;
};

export type CalibrationLine = {
  snapshot_id: string;
  line_id: string;
  page_number: number;
  line_number: number;
  bbox: Rect;
  /** The writing band, top and bottom, page y. */
  band: [number, number];
  image_url?: string;
  labels_url?: string;
  /** The original's line id, on a line carried into a copied mushaf. */
  source_line_id?: string;
  /** A neighbouring page's line, shown for the ayat that cross the page break. */
  readonly: boolean;
  /** Read-only and confirmed on its own page: fixed context. */
  approved: boolean;
  status: "exact" | "scored" | "partial" | "unresolved" | null;
  reason: string | null;
  blobs: CalibrationBlob[];
  words: CalibrationWord[];
};

export type CalibrationProfile = {
  signature: string;
  mode: "shadow" | string;
  /** Confirmed pages the examples come from — always earlier than this one. */
  pages: number[];
  examples: number;
};

export type CalibrationDocument = {
  settings?: { revision: number; experimental: boolean };
  page: number;
  revision: number;
  confirmed_revision: number | null;
  /** The page has been processed for calibration and has a draft. */
  processed: boolean;
  /** The page's lines changed since processing: the draft is read-only. */
  stale: boolean;
  /** A neighbouring page's line the page's ayat cross onto changed since it was
   * processed: it can be edited, saved and confirmed, but not read again — preview
   * is refused — until it is processed again, which keeps its decisions. */
  context_stale?: boolean;
  /** A preview response: shown, never stored. */
  preview?: boolean;
  profile: CalibrationProfile;
  lines: CalibrationLine[];
  context: CalibrationLine[];
  issues: string[];
  words: PageWords;
  processed_revision?: number;
};

/** What a save, preview or confirmation sends: the page's editable lines, whole. */
export type CalibrationDraft = {
  revision: number;
  request_id: string;
  acknowledge_exceptions?: boolean;
  /** Read the page again under these edits before storing it: how a preview is
   * accepted, so the stored draft carries the preview's verdicts and flags too. */
  realign?: boolean;
  lines: {
    snapshot_id: string;
    blobs: Pick<
      CalibrationBlob,
      | "id"
      | "role"
      | "explicit"
      | "ownership_explicit"
      | "subtype"
      | "subtype_explicit"
      | "exception"
      | "allocations"
    >[];
    words: Pick<CalibrationWord, "word_id" | "start_x" | "end_x" | "override" | "shared">[];
  }[];
};

/** A guessed type for one mark nobody has typed. `sure` when its source is sure. */
export type TypeSuggestion = {
  snapshot_id: string;
  blob_id: number;
  subtype: string;
  confidence: number;
  sure: boolean;
  /** Where it comes from: the type the word's text names for the mark ("text"), the
   * typed marks of the confirmed pages and of this one ("examples"), or the ink's
   * arrangement — three loose dots in a triangle, the embraced pause sign ("image"). */
  source?: "text" | "examples" | "image";
  /** The type the text names, when the examples are sure of another: worth a look. */
  text?: string;
};

/** A mark typed on this page that the other pages' examples take for another type:
 * a slip of the hand, most often — worth a second look before it teaches. */
export type TypeDoubt = {
  snapshot_id: string;
  blob_id: number;
  /** What it is typed as. */
  typed: string;
  /** What the other pages' examples say it is — or the word's text. */
  subtype: string;
  sure: boolean;
  /** Who doubts it: the word's text, or the other pages' examples. */
  source?: "text" | "examples";
};

/** One word's marks against the marks its text names. */
export type WordMarkCheck = {
  snapshot_id: string;
  word_id: number;
  /** Nothing missing, nothing left over, nothing typed as another type. */
  ok: boolean;
  /** Types of the marks the text requires and the ink lacks. */
  missing: string[];
  /** Blobs the text has no mark for (pause signs aside: readings differ). */
  extra: number[];
  /** Typed blobs the text names otherwise. */
  disagree: number[];
};

export type CalibrationTypes = {
  suggestions: TypeSuggestion[];
  doubts: TypeDoubt[];
  /** Typed marks on the confirmed pages the guesses learned from. */
  examples: number;
  /** Typed marks on this page, sent with the draft. */
  typed_here: number;
  /** Every word's check against its text. */
  words?: WordMarkCheck[];
  /** The marks that are strokes of a tanween, each typed as its vowel. */
  tanween?: { snapshot_id: string; blob_id: number }[];
};

/** One typed mark shown as evidence: where it was typed, and how near it is. */
export type TypeEvidenceExample = {
  snapshot_id: string;
  blob_id: number;
  page_number: number;
  line_number: number;
  distance: number;
  /** How many identical typed marks this example stands for. */
  copies: number;
  image_url: string;
  /** The mark's box inside that line's image, image pixels. */
  crop: Rect;
};

/** Why one mark is expected to be what it is: the types nearest it, nearest first,
 * each scored by the mean distance to its own nearest examples — which it carries. */
export type TypeEvidence = {
  snapshot_id: string;
  blob_id: number;
  /** A typed mark is compared with the other pages only — the question its doubt asks. */
  typed: boolean;
  candidates: { subtype: string; distance: number; examples: TypeEvidenceExample[] }[];
};

export type CalibrationPageState = {
  page: number;
  revision: number;
  confirmed_revision: number | null;
  processed: boolean;
};

export type CalibrationExample = {
  snapshot_id: string;
  blob_id: number;
  page_number: number;
  line_number: number;
  role: TextRole;
  subtype: string;
  distance: number;
  /** How many identical confirmed blobs this example stands for. */
  copies: number;
  image_url: string | null;
  /** The blob's box inside that line's image, image pixels. */
  crop: Rect | null;
};

export type CalibrationExamples = {
  proposed_role: TextRole | null;
  confidence: number;
  reasons: string[];
  support_count?: number;
  distinct_pages?: number;
  neighbors: CalibrationExample[];
  mode: string;
};

export type EvaluationCounts = Partial<{
  body_as_mark: number;
  mark_as_body: number;
  /** On the right line, an edge off by more than the tolerance. */
  words_moved: number;
  /** Placed, but on another line than the confirmation's. */
  words_wrong_line: number;
  words_missing: number;
  /** Placed more than once. */
  words_duplicated: number;
  /** Placed on the page, though the confirmation has no such word there. */
  words_extra: number;
}>;

export type CalibrationEvaluation = {
  mode: string;
  activation_allowed: boolean;
  gate: string;
  confirmed_pages: number;
  totals: Record<"frozen" | "canonical" | "calibrated", EvaluationCounts>;
  pages: {
    page: number;
    blobs: number;
    words: number;
    released_locks: number;
    proposals: Record<TextRole, { made: number; wrong: number }>;
    results: Record<"frozen" | "canonical" | "calibrated", EvaluationCounts>;
  }[];
};

export type CalibrationComparison = {
  page: number;
  confirmed_revision: number;
  processed_revision: number;
  profile: CalibrationProfile;
  lines: {
    line_number: number;
    bbox: Rect;
    image_url?: string;
    readings: Record<
      "frozen" | "canonical" | "calibrated" | "confirmed",
      {
        words: Pick<CalibrationWord, "word_id" | "start_x" | "end_x">[];
        unavailable: boolean;
      }
    >;
  }[];
};

// The calibration document, exactly as backend/api/services/calibration.py sends it.
//
// EVERYTHING IS IN PAGE PIXELS — blob boxes, word edges, line boxes — the same space
// the served page image and the word cuts live in. A line's `image_url` is that
// line's own crop of the page (its `bbox`), and `labels_url` is a raster the same
// size in which every pixel's blob id is encoded as R + 256·G + 65536·B (0 is
// background): the map clicks are hit-tested against.
import type { BatchReason, Rect } from "../api/types";

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
  /** A person erased it: noise the line's cutting left, not ink of the text. It
   * belongs to no word, is read around, teaches nothing, and the exported line image
   * is cut without it. `false` once restored; absent on a blob never erased. */
  erased?: boolean;
};

export type CalibrationWord = {
  word_id: number | null;
  text: string;
  aya: string;
  expected_paws: number;
  /** The word's RIGHT edge — the larger number; Arabic runs right to left. Both
   * edges are the extent of the ink given to the word. */
  start_x: number;
  end_x: number;
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
  /** Confirmed pages the examples come from — every one but this page. */
  pages: number[];
  examples: number;
  /** The distinct shapes the library grouped those examples into, at `limit`. */
  fingerprints?: number;
  limit?: number;
};

/** A mushaf's calibration settings. `limit` is the fingerprint library's LIMIT in
 * force — `default_limit` unless one was set — in its `comparison`'s own units. */
export type CalibrationSettings = {
  revision: number;
  comparison: string;
  limit: number;
  default_limit: number;
};

/** An aya the reading left with fewer PAWs than its words spell — most often two
 * PAWs printed touching. `words` are the words that came up short; `certain` is false
 * when equal-cost readings could have put the shortage in another word. */
export type PawShortage = {
  aya: string;
  short: number;
  words: number[];
  certain: boolean;
};

export type CalibrationDocument = {
  settings?: CalibrationSettings;
  /** Ayat short of PAWs after the last reading. Absent from older drafts. */
  shortages?: PawShortage[];
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
      | "erased"
    >[];
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
   * arrangement — three loose dots in a triangle, the embraced pause sign ("image"); a
   * dot inside a pause sign, or the sign around one, the sign's ("sign"). */
  source?: "text" | "examples" | "image" | "sign";
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
  /** Who doubts it: the word's text, the other pages' examples, or the pause sign it
   * is part of, typed otherwise. */
  source?: "text" | "examples" | "sign";
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

/** A mark that may be noise the line's cutting left — a person erases it or not.
 * A `speck` is a few pixels of ink: the tip of a letter of the line above, cut with
 * this one, or a stray dot of the scan. A `stranger` looks like nothing the library
 * keeps and its word's text has it left over. `edge`: it touches the line's box. */
export type NoiseSuspect = {
  snapshot_id: string;
  blob_id: number;
  kind: "speck" | "stranger";
  edge: boolean;
  /** To the nearest kept shape, in LIMITs — for a left-over mark only. */
  distance: number | null;
};

export type CalibrationTypes = {
  suggestions: TypeSuggestion[];
  doubts: TypeDoubt[];
  /** Marks that may be noise. Absent from older servers. */
  noise?: NoiseSuspect[];
  /** Typed marks on the confirmed pages the guesses learned from. */
  examples: number;
  /** Typed marks on this page, sent with the draft. */
  typed_here: number;
  /** Every word's check against its text. */
  words?: WordMarkCheck[];
  /** The marks that are strokes of a tanween, each typed as its vowel. */
  tanween?: { snapshot_id: string; blob_id: number }[];
};

export type CalibrationPageState = {
  page: number;
  revision: number;
  confirmed_revision: number | null;
  processed: boolean;
};

/** One confirmed example as the Library mode draws it: where it is, and its crop of
 * its line's image (image pixels). `looks_right` is a person's check that still
 * stands for the label it is confirmed as. */
export type LibraryShape = {
  key: string;
  snapshot_id: string;
  blob_id: number;
  page_number: number;
  line_number: number;
  image_url: string;
  /** The line image's size, image pixels. */
  image_size: { w: number; h: number };
  crop: Rect;
  area: number;
  confirmed_at: string | null;
  looks_right: boolean;
  /** To the group's fingerprint, for a member. */
  distance?: number;
};

/** One fingerprint and the members kept beside it, spread nearest to farthest. */
export type LibraryGroup = {
  /** Stable for one build of the library: what the members are asked by. */
  id: string;
  count: number;
  /** The distance of its farthest member from the fingerprint. */
  farthest: number;
  fingerprint: LibraryShape;
  kept: LibraryShape[];
};

/** A kind of example: the letters, one mark type, or the untyped marks. */
export type LibraryKind = {
  role: TextRole;
  subtype: string;
  examples: number;
  groups: LibraryGroup[];
};

/** The library that answers for one page: every other confirmed page, grouped. */
export type CalibrationLibrary = {
  page: number;
  /** Built at another LIMIT for the asking; nothing saved. */
  preview: boolean;
  limit: number;
  saved_limit: number;
  default_limit: number;
  comparison: string;
  /** The confirmed pages it is built from. */
  pages: number[];
  /** The page itself, when it is confirmed: never in its own library. */
  left_out: number | null;
  /** The pages the page's draft was read with, when it was processed. */
  draft_pages: number[] | null;
  examples: number;
  fingerprints: number;
  kinds: LibraryKind[];
};

export type LibraryMembers = {
  group: string;
  total: number;
  offset: number;
  members: LibraryShape[];
};

/** One blob of the page against the library: what it answers, and the blob's
 * distance to every kept shape, by `LibraryShape.key`. */
export type LibraryCompare = {
  snapshot_id: string;
  blob_id: number;
  role: string;
  subtype: string;
  typed: boolean;
  answer: {
    role: TextRole;
    confidence: number;
    nearest_letter: number;
    nearest_mark: number;
    letter: string;
    mark: string;
  } | null;
  type: {
    subtype: string;
    distance: number | null;
    sure: boolean;
    runner_up: string;
    runner_distance: number | null;
  } | null;
  distances: Record<string, number>;
  /** How many marks typed on this page took part in an untyped mark's guess. */
  own: number;
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

/** One check behind the readiness meter — see backend/api/services/calibration_progress.py.
 * `unknown`: not yet the confirmed pages to tell. */
export type ReadinessCheck =
  | {
      key: "pages";
      score: number;
      state: ReadinessState;
      values: { count: number; target: number };
    }
  | {
      key: "trust";
      score: number;
      state: ReadinessState;
      values: { made: number; wrong: number; pages: number };
    }
  | {
      key: "settled";
      score: number;
      state: ReadinessState;
      /** `growth`: points of share gained per page, fitted over the latest `pages`. */
      values: { pages: number; latest: number; growth: number | null };
    }
  | {
      key: "fixes";
      score: number;
      state: ReadinessState;
      /** `rate`: roles and types fixed per 1,000 blobs of the latest first drafts. */
      values: {
        pages: number;
        fixed: number;
        rate: number | null;
        per_page: number | null;
        words_per_page: number | null;
      };
    };

export type ReadinessState = "pass" | "near" | "fail" | "unknown";

/** Whether calibration has learned enough that processing the rest in bulk loses
 * little. An estimate from the confirmed pages, never a verdict. */
export type CalibrationReadiness = {
  /** 0–100. */
  score: number;
  level: "keep" | "close" | "ready";
  checks: ReadinessCheck[];
  /** Every confirmed page, in page order. */
  pages: {
    page: number;
    blobs: number;
    /** Share of the page's text blobs the learning proposed a role for, in percent. */
    coverage: number;
    learned_wrong: number;
    /** Roles and types fixed on the first draft; null when no first draft was kept. */
    fixes: number | null;
    /** Words whose box ended up different from the first draft's. */
    words: number;
    words_total: number;
    minutes: number;
  }[];
  cost: { process_seconds: number | null; review_minutes: number | null };
};

/** What a batch over a range would do, page by page — nothing is started. */
export type BatchPlan = {
  first: number;
  last: number;
  refresh: boolean;
  pages: Partial<Record<BatchReason, number[]>>;
  /** Pages sure to be processed. */
  process: number;
  /** Drafts not confirmed, processed again only if their lines changed. */
  drafted: number;
  /** What a page has taken to process here lately; null before any has. */
  process_seconds: number | null;
};

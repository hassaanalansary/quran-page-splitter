// The editable model behind calibration review, and the rules that keep it honest.
//
// Pure — no React, no fetching — so it runs directly under
// `node --experimental-strip-types` (see model.check.ts beside it).
//
// The state is the page's editable lines, exactly as the server sends them. Every
// edit returns new lines; nothing is mutated, which is what lets undo keep whole
// states. Context lines (a neighbouring page's) are never edited here.
//
// Three rules the server also enforces, restated where the edits happen:
//   * a MARK carries no PAW of any word — turning a body into a mark keeps its
//     attachment to the word (for display) but drops its share of the count, and
//     turning it back makes it an ordinary one-PAW body again;
//   * a word's box spans all the ink it owns, bodies and marks alike — so a mark
//     given to a word stretches it, and one taken away shrinks it;
//   * a dragged edge is an override the next alignment keeps — until the reviewer
//     reassigns that word's bodies, which recalculates it and clears the override.
//     Moving a mark never clears one: a mark is not a statement about the cut. But
//     a dragged box still holds all the ink its word owns alone (`fitWord`): a drag
//     widens a box, or moves the cut inside a body two words share — it never
//     leaves the word's own ink outside.
import type {
  Allocation,
  BlobException,
  CalibrationBlob,
  CalibrationDocument,
  CalibrationDraft,
  CalibrationLine,
  CalibrationWord,
  TextRole,
  TypeDoubt,
  TypeSuggestion,
  WordMarkCheck,
} from "./types.ts";

// ── Selection ────────────────────────────────────────────────────────────────

/** Blobs selected on one line. Selection never spans lines: every edit here acts on
 * one line's blobs, and a line is where word ownership is decided. */
export type BlobSelection = { snapshot: string; ids: number[] };
export const NO_SELECTION: BlobSelection = { snapshot: "", ids: [] };

export function isSelected(selection: BlobSelection, snapshot: string, id: number): boolean {
  return selection.snapshot === snapshot && selection.ids.includes(id);
}

/** Add, toggle or replace ids, the way a click, shift-click or drag asks. */
export function selectIds(
  current: number[],
  hits: number[],
  additive: boolean,
  toggle = false,
): number[] {
  if (!additive) return [...new Set(hits)];
  const next = new Set(current);
  hits.forEach((id) => (toggle && next.has(id) ? next.delete(id) : next.add(id)));
  return [...next];
}

// ── History ──────────────────────────────────────────────────────────────────

export type History<T> = { stack: T[]; index: number };
const HISTORY_LIMIT = 100;

export const historyOf = <T>(initial: T): History<T> => ({ stack: [initial], index: 0 });

export function pushHistory<T>(history: History<T>, next: T): History<T> {
  if (history.stack[history.index] === next) return history;
  const stack = [...history.stack.slice(0, history.index + 1), next].slice(-HISTORY_LIMIT);
  return { stack, index: stack.length - 1 };
}

export function stepHistory<T>(history: History<T>, delta: -1 | 1): History<T> {
  return {
    ...history,
    index: Math.max(0, Math.min(history.stack.length - 1, history.index + delta)),
  };
}

export const currentOf = <T>(history: History<T>): T => history.stack[history.index];

// ── What is sent ─────────────────────────────────────────────────────────────

/** The PUT/POST body: the page's editable lines, whole. Context lines never travel
 * back — they are not this page's to change. */
export function draftOf(
  doc: Pick<CalibrationDocument, "revision">,
  lines: CalibrationLine[],
  requestId: string,
  acknowledge = false,
): CalibrationDraft {
  return {
    revision: doc.revision,
    request_id: requestId,
    acknowledge_exceptions: acknowledge,
    lines: lines
      .filter((line) => !line.readonly)
      .map((line) => ({
        snapshot_id: line.snapshot_id,
        blobs: line.blobs.map(
          ({
            id,
            role,
            explicit,
            ownership_explicit,
            subtype,
            subtype_explicit,
            exception,
            allocations,
          }) => ({
            id,
            role,
            explicit,
            ownership_explicit,
            subtype,
            subtype_explicit: subtype_explicit ?? !!subtype,
            exception,
            allocations,
          }),
        ),
        words: line.words.map(({ word_id, start_x, end_x, override, shared }) => ({
          word_id,
          start_x,
          end_x,
          override,
          shared,
        })),
      })),
  };
}

/** Everything a save would send, as one string — equal strings, nothing to save. */
export function editSignature(lines: CalibrationLine[]): string {
  return JSON.stringify(draftOf({ revision: 0 }, lines, "").lines);
}

/** A fresh v4 UUID for `request_id`.
 *
 * `crypto.randomUUID` exists only in a secure context — https, or localhost — so a
 * copy served over plain http on a LAN would have none; `getRandomValues` exists
 * everywhere. */
export function newRequestId(): string {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Request ids that make a retry land once.
 *
 * The server applies a `request_id` at most once. A save whose answer was lost on
 * the way back has still landed, so sending the same edits again must reuse its id
 * — a new one would be refused as made on an old revision. `key` names the exact
 * request (what it is, which revision, which edits); the id is kept until the
 * server has answered it, either way. */
export function requestIds() {
  let held: { key: string; id: string } | null = null;
  return {
    for(key: string): string {
      if (held?.key !== key) held = { key, id: newRequestId() };
      return held.id;
    },
    /** The server answered — success or refusal. A network failure keeps the id. */
    answered(key: string) {
      if (held?.key === key) held = null;
    },
  };
}

// ── Counts ───────────────────────────────────────────────────────────────────

/** PAWs this line's bodies give a word. */
export function pawsOf(line: CalibrationLine, wordId: number | null): number {
  if (wordId === null) return 0;
  let total = 0;
  for (const blob of line.blobs) {
    if (blob.role !== "body") continue;
    for (const allocation of blob.allocations)
      if (allocation.word_id === wordId) total += allocation.paws;
  }
  return total;
}

/** The blobs this line gives a word — its bodies and the marks attached to them. */
export function inkOf(line: CalibrationLine, wordId: number | null): number[] {
  if (wordId === null) return [];
  return line.blobs
    .filter((blob) => blob.allocations.some((allocation) => allocation.word_id === wordId))
    .map((blob) => blob.id);
}

/** A word's count as a badge reads it: what it got against what its spelling wants.
 *
 * Exact for a word sharing a blob too: a shared blob gives each of its words the
 * PAWs it was given for that word, so both counts close only when the share is
 * right — the server's `exceptions()` counts the same way. */
export function wordCount(line: CalibrationLine, word: CalibrationWord) {
  const got = pawsOf(line, word.word_id);
  return { got, want: word.expected_paws, ok: word.word_id === null || got === word.expected_paws };
}

/** What a confirmation must acknowledge. Mirrors `exceptions()` in
 * backend/api/services/calibration.py, which re-checks it: counts that do not
 * close, ink flagged by hand, and lines the last alignment could not settle. */
export type PageException = {
  kind: "flagged" | "paw-count" | "unresolved";
  line_number: number;
  detail: string;
};

export function pageExceptions(lines: CalibrationLine[]): PageException[] {
  const found: PageException[] = [];
  for (const line of lines) {
    if (line.readonly) continue;
    for (const blob of line.blobs) {
      if (blob.exception)
        found.push({ kind: "flagged", line_number: line.line_number, detail: blob.exception });
    }
    for (const word of line.words) {
      const count = wordCount(line, word);
      if (!count.ok) {
        found.push({
          kind: "paw-count",
          line_number: line.line_number,
          detail: `${word.text}: ${count.got}/${count.want}`,
        });
      }
    }
    if (line.status === "partial" || line.status === "unresolved") {
      found.push({ kind: "unresolved", line_number: line.line_number, detail: line.reason ?? "" });
    }
  }
  return found;
}

// ── Attention ────────────────────────────────────────────────────────────────

/** A blob the reviewer should look at: flagged by the server, or by them. */
export function needsLook(blob: CalibrationBlob): boolean {
  return activeAttention(blob).length > 0 || blob.exception === "uncertain";
}

/** Human classification settles historical classifier doubts, not geometry conflicts. */
export function activeAttention(blob: CalibrationBlob): string[] {
  const roleFlags = [
    "uncertain",
    "ambiguous",
    "search-override",
    "calibration-disagreement",
    "released-lock",
  ];
  return blob.attention.filter(
    (flag) => !(blob.explicit || blob.ownership_explicit) || !roleFlags.includes(flag),
  );
}

/** Every blob worth a look on the editable lines, in reading order: line by line,
 * right to left. */
export function attentionItems(lines: CalibrationLine[]): BlobSelection[] {
  return lines
    .filter((line) => !line.readonly)
    .flatMap((line) =>
      [...line.blobs]
        .filter(needsLook)
        .sort((a, b) => b.x + b.w - (a.x + a.w))
        .map((blob) => ({ snapshot: line.snapshot_id, ids: [blob.id] })),
    );
}

/** The next (or previous) blob worth a look, wrapping around; null when there is none. */
export function stepAttention(
  lines: CalibrationLine[],
  current: BlobSelection,
  delta: -1 | 1,
): BlobSelection | null {
  const items = attentionItems(lines);
  if (!items.length) return null;
  const at = items.findIndex(
    (item) => item.snapshot === current.snapshot && current.ids.includes(item.ids[0]),
  );
  if (at < 0) return items[delta === 1 ? 0 : items.length - 1];
  return items[(at + delta + items.length) % items.length];
}

// ── Edges ────────────────────────────────────────────────────────────────────

function ownersOf(blob: CalibrationBlob): number[] {
  return blob.allocations.map((allocation) => allocation.word_id);
}

/** A word's right and left edge, from all text ink given to it — the server's
 * `_edges_from_ink`, pixel for pixel.
 *
 * Where a body is shared with the word before (to the right, a smaller id), the
 * word starts at the body's middle; shared with the word after, it ends there. The
 * middle is only a first guess at a cut that lies somewhere inside one piece of
 * ink — the reviewer's to drag. Null when the word has no ink of its own. */
export function edgesFromInk(
  line: CalibrationLine,
  wordId: number,
): { start_x: number; end_x: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const blob of line.blobs) {
    const ids = blob.allocations.map((allocation) => allocation.word_id);
    if (!isText(blob) || !ids.includes(wordId)) continue;
    const middle = blob.x + Math.floor(blob.w / 2);
    const right = ids.some((id) => id < wordId) ? middle : blob.x + blob.w;
    const left = ids.some((id) => id > wordId) ? middle : blob.x;
    start = start === null ? right : Math.max(start, right);
    end = end === null ? left : Math.min(end, left);
  }
  return start === null || end === null || start <= end ? null : { start_x: start, end_x: end };
}

/** The right and left edge of the ink only this word owns: its bodies and marks
 * that no other word shares. The server's `_own_extent`. */
function ownExtent(line: CalibrationLine, wordId: number): { right: number; left: number } | null {
  let right: number | null = null;
  let left: number | null = null;
  for (const blob of line.blobs) {
    if (!isText(blob) || !blob.allocations.length) continue;
    if (!blob.allocations.every((allocation) => allocation.word_id === wordId)) continue;
    right = right === null ? blob.x + blob.w : Math.max(right, blob.x + blob.w);
    left = left === null ? blob.x : Math.min(left, blob.x);
  }
  return right === null || left === null ? null : { right, left };
}

/** A word's box, widened to hold all the ink it owns alone — the server's
 * `_fit_words`, pixel for pixel. A box set by hand keeps where the hand put it, but
 * never leaves its word's own bodies or marks outside; the cut inside a body two
 * words share stays the hand's to place. */
export function fitWord(line: CalibrationLine, word: CalibrationWord): CalibrationWord {
  if (word.word_id === null) return word;
  const extent = ownExtent(line, word.word_id);
  if (!extent) return word;
  const start_x = Math.max(word.start_x, extent.right);
  const end_x = Math.min(word.end_x, extent.left);
  return start_x === word.start_x && end_x === word.end_x ? word : { ...word, start_x, end_x };
}

/** Recalculate the named words' edges from the bodies and marks that belong to them.
 *
 * `clear` is an explicit reassignment: it recalculates even a hand-dragged word and
 * drops the override, because the reviewer has just said which ink the word is — all
 * but a cut inside a body two words share, which ink cannot place, unless `force`
 * says the reviewer asked for exactly that word. A word left with no body keeps its
 * old edges (a box needs numbers); its badge says 0 of N. */
function recalculate(
  line: CalibrationLine,
  words: Set<number>,
  clear: boolean,
  force = false,
): CalibrationLine {
  if (!words.size) return line;
  return {
    ...line,
    words: line.words.map((word) => {
      if (word.word_id === null || !words.has(word.word_id)) return word;
      const id = word.word_id;
      const shared = line.blobs.some(
        (blob) =>
          blob.role === "body" &&
          blob.allocations.length > 1 &&
          blob.allocations.some((allocation) => allocation.word_id === id),
      );
      // An internal cut in shared ink is not recoverable from component bounds.
      const next = {
        ...word,
        shared,
        override: clear && (!shared || force) ? false : word.override,
      };
      if (next.override) return fitWord(line, next);
      const edges = edgesFromInk(line, id);
      return edges ? { ...next, ...edges } : next;
    }),
  };
}

function onLine(
  lines: CalibrationLine[],
  selection: BlobSelection,
  edit: (line: CalibrationLine, chosen: Set<number>) => CalibrationLine,
): CalibrationLine[] {
  const chosen = new Set(selection.ids);
  if (!chosen.size) return lines;
  return lines.map((line) =>
    line.readonly || line.snapshot_id !== selection.snapshot ? line : edit(line, chosen),
  );
}

const isText = (blob: CalibrationBlob) => blob.role === "body" || blob.role === "mark";

// ── Edits ────────────────────────────────────────────────────────────────────

/** Say what the selected blobs are. A decision, so it becomes a hard constraint.
 *
 * Ornaments and symbols are structure and keep their role. A blob becoming a mark
 * keeps its attachment but gives back its PAWs; a mark becoming a body is an
 * ordinary one-PAW letter piece until the reviewer says otherwise — left at the
 * mark's zero, it would read as a broken fragment. Either way, the words it
 * belongs to recalculate. */
export function setRole(
  lines: CalibrationLine[],
  selection: BlobSelection,
  role: TextRole,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !isText(blob)) return blob;
      if (blob.role !== role) ownersOf(blob).forEach((id) => affected.add(id));
      const allocations =
        role === "mark"
          ? blob.allocations.map((allocation) => ({ ...allocation, paws: 0 }))
          : blob.role === "mark"
            ? blob.allocations.map((allocation) => ({ ...allocation, paws: allocation.paws || 1 }))
            : blob.allocations;
      return {
        ...blob,
        role,
        explicit: true,
        allocations,
        subtype: role === "mark" ? blob.subtype : "",
        subtype_explicit: role === "mark" ? blob.subtype_explicit : false,
        subtype_source: role === "mark" ? blob.subtype_source : undefined,
        decision_source: "human" as const,
      };
    });
    return recalculate({ ...line, blobs }, affected, false);
  });
}

export function setException(
  lines: CalibrationLine[],
  selection: BlobSelection,
  exception: BlobException,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) =>
      chosen.has(blob.id) && isText(blob) ? { ...blob, exception } : blob,
    ),
  }));
}

export function setSubtype(
  lines: CalibrationLine[],
  selection: BlobSelection,
  subtype: string,
): CalibrationLine[] {
  const value = subtype.trim().slice(0, 32);
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) =>
      chosen.has(blob.id) && blob.role === "mark"
        ? {
            ...blob,
            subtype: value,
            subtype_explicit: true,
            subtype_source: undefined,
            explicit: true,
            decision_source: "human" as const,
          }
        : blob,
    ),
  }));
}

// ── Pairs: marks printed as one ────────────────────────────────────────────

/** The order a pair's names are written in — the server's `mark_check.COMPOUND_ORDER`,
 * so both name a hamza printed with its kasra "hamza+kasra". */
export const COMPOUND_ORDER: readonly string[] = [
  "hamza",
  "wasla",
  "madda",
  "daggerAlif",
  "shadda",
  "fatha",
  "damma",
  "kasra",
  "sukun",
  "roundZero",
  "rectZero",
  "tanween",
  "smallLetter",
  "ijamDot",
  "waqfSili",
  "waqfQili",
  "waqfJim",
  "waqfMim",
  "waqfLa",
  "waqfMuanaqa",
  "other",
];

/** A type's parts: one for a single mark, two or more for marks printed as one. */
export const subtypeParts = (subtype: string): string[] =>
  subtype ? subtype.split("+").filter(Boolean) : [];

/** Marks printed as one, named in `COMPOUND_ORDER`; one part is just that type. */
export function composeSubtype(parts: string[]): string {
  const rank = (part: string) => {
    const at = COMPOUND_ORDER.indexOf(part);
    return at < 0 ? COMPOUND_ORDER.length : at;
  };
  return [...new Set(parts)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join("+");
}

/** A type with `part` added — or taken off, when it has it and more besides. */
export function togglePart(subtype: string, part: string): string {
  const parts = subtypeParts(subtype);
  if (!parts.includes(part)) return composeSubtype([...parts, part]);
  const rest = parts.filter((other) => other !== part);
  return rest.length ? composeSubtype(rest) : subtype;
}

/** Add a type to the selected marks' own — a hamza printed touching its kasra is typed
 * "hamza+kasra" — or take it off again. Starts from the type each mark shows, typed
 * or expected. Typing, so a decision. */
export function addSubtypePart(
  lines: CalibrationLine[],
  selection: BlobSelection,
  part: string,
  expectations: Expectations,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || blob.role !== "mark") return blob;
      const shown = shownType(blob, line.snapshot_id, expectations);
      return {
        ...blob,
        subtype: togglePart(shown?.subtype ?? "", part),
        subtype_explicit: true,
        subtype_source: undefined,
        explicit: true,
        decision_source: "human" as const,
      };
    }),
  }));
}

/** Explicitly unattached marks must not be reattached by the next preview. */
export function unassignMarks(
  lines: CalibrationLine[],
  selection: BlobSelection,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || blob.role !== "mark") return blob;
      ownersOf(blob).forEach((id) => affected.add(id));
      return {
        ...blob,
        allocations: [],
        ownership_explicit: true,
        explicit: true,
        decision_source: "human" as const,
      };
    });
    return recalculate({ ...line, blobs }, affected, false);
  });
}

/** Take the reviewer's decisions off the selected blobs: the next preview is free to
 * read them again. Their current role and allocations stay until it does. */
export function releaseDecisions(
  lines: CalibrationLine[],
  selection: BlobSelection,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) =>
      chosen.has(blob.id)
        ? {
            ...blob,
            explicit: false,
            ownership_explicit: false,
            decision_source: "search" as const,
          }
        : blob,
    ),
  }));
}

/** Give the selected blobs to one word.
 *
 * Bodies carry `paws` each (1 an ordinary letter piece, 0 a broken fragment, 2 two
 * bodies printed touching); marks carry none. This records ownership — it does not
 * change anybody's role. Every word that gained or lost a *body* recalculates, and
 * its dragged override is cleared: the reviewer has just said which ink it is.
 * Marks also resize automatic extents, but do not clear deliberate dragged edges. */
export function assignToWord(
  lines: CalibrationLine[],
  selection: BlobSelection,
  wordId: number,
  paws = 1,
): CalibrationLine[] {
  const count = Math.max(0, Math.min(8, Math.round(paws)));
  return onLine(lines, selection, (line, chosen) => {
    if (!line.words.some((word) => word.word_id === wordId)) return line;
    const affected = new Set<number>();
    const markWords = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !isText(blob)) return blob;
      if (blob.role === "body") {
        affected.add(wordId);
        ownersOf(blob).forEach((id) => affected.add(id));
      } else {
        markWords.add(wordId);
        ownersOf(blob).forEach((id) => markWords.add(id));
      }
      const share: Allocation = { word_id: wordId, paws: blob.role === "body" ? count : 0 };
      return { ...blob, allocations: [share], ownership_explicit: true };
    });
    return recalculate(recalculate({ ...line, blobs }, affected, true), markWords, false);
  });
}

/** One body printed touching across a word break: it belongs to both words.
 *
 * Each word is given its own share of the blob's PAWs, so both counts close on
 * their own. The alignment reads the joined words as one unit and splits them
 * again at this blob; until a hand drags it, the cut between them sits at the
 * blob's middle (see `edgesFromInk`). */
export function shareBetween(
  lines: CalibrationLine[],
  selection: BlobSelection,
  shares: Allocation[],
): CalibrationLine[] {
  const valid = shares.filter((share) => share.paws >= 0);
  if (selection.ids.length !== 1 || valid.length < 2) return lines;
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>(valid.map((share) => share.word_id));
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || blob.role !== "body") return blob;
      ownersOf(blob).forEach((id) => affected.add(id));
      return {
        ...blob,
        allocations: valid.map((share) => ({ ...share })),
        ownership_explicit: true,
      };
    });
    return recalculate({ ...line, blobs }, affected, false);
  });
}

/** Drag a word's edge by hand: an override the next alignment keeps — held open
 * wide enough for the word's own ink (see `fitWord`). */
export function setWordEdges(
  lines: CalibrationLine[],
  snapshot: string,
  index: number,
  start: number,
  end: number,
): CalibrationLine[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return lines;
  return lines.map((line) => {
    if (line.readonly || line.snapshot_id !== snapshot || !line.words[index]) return line;
    const left = line.bbox.x;
    const right = line.bbox.x + line.bbox.w;
    const end_x = Math.max(left, Math.min(right - 1, Math.round(end)));
    const start_x = Math.max(end_x + 1, Math.min(right, Math.round(start)));
    return {
      ...line,
      words: line.words.map((word, i) =>
        i === index ? fitWord(line, { ...word, start_x, end_x, override: true }) : word,
      ),
    };
  });
}

/** Drop a word's hand-set edges and take them from its ink again — a cut inside a
 * shared body too, which goes back to the body's middle. */
export function resetWordEdges(
  lines: CalibrationLine[],
  snapshot: string,
  index: number,
): CalibrationLine[] {
  return lines.map((line) => {
    const word = line.words[index];
    if (line.readonly || line.snapshot_id !== snapshot || !word || word.word_id === null)
      return line;
    return recalculate(line, new Set([word.word_id]), true, true);
  });
}

/** Take every hand-set box on the page from its ink again, as one edit — except a
 * cut inside a body two words share, which only a hand can place. */
export function resetAllEdges(lines: CalibrationLine[]): CalibrationLine[] {
  return lines.map((line) => {
    if (line.readonly) return line;
    const ids = new Set(
      line.words
        .filter((word) => word.override && !word.shared && word.word_id !== null)
        .map((word) => word.word_id as number),
    );
    return ids.size ? recalculate(line, ids, true) : line;
  });
}

/** Page px a hand-set box reaches past its word's ink, both sides together: 0 for a
 * box taken from its ink, for a cut inside a shared body, and for a word with none. */
export function overshoot(line: CalibrationLine, word: CalibrationWord): number {
  if (!word.override || word.shared || word.word_id === null) return 0;
  const ink = edgesFromInk(line, word.word_id);
  if (!ink) return 0;
  return Math.max(0, word.start_x - ink.start_x) + Math.max(0, ink.end_x - word.end_x);
}

/** A box further than this past its ink is not a hair's difference: it holds nothing
 * of its word, and a confirmation would write it as the word's cut. */
export const OVERSHOOT_PX = 3;

/** The page's hand-set boxes that a page-wide reset would take from their ink, and
 * how many of those reach past it. */
export function handSetBoxes(lines: CalibrationLine[]) {
  let count = 0;
  let wide = 0;
  for (const line of lines) {
    if (line.readonly) continue;
    for (const word of line.words) {
      if (!word.override || word.shared || word.word_id === null) continue;
      count += 1;
      if (overshoot(line, word) > OVERSHOOT_PX) wide += 1;
    }
  }
  return { count, wide };
}

/** Take a preview's alignment, keeping every edge the reviewer dragged by hand.
 * One call, so accepting a preview is one undo step. */
export function mergePreview(
  current: CalibrationLine[],
  preview: CalibrationLine[],
): CalibrationLine[] {
  return current.map((line) => {
    if (line.readonly) return line;
    const next = preview.find((candidate) => candidate.snapshot_id === line.snapshot_id);
    if (!next) return line;
    const dragged = new Map(
      line.words
        .filter((word) => word.override && word.word_id !== null)
        .map((word) => [word.word_id, word]),
    );
    return {
      ...next,
      words: next.words.map((word) => {
        const kept = word.word_id === null ? undefined : dragged.get(word.word_id);
        return kept
          ? fitWord(next, { ...word, start_x: kept.start_x, end_x: kept.end_x, override: true })
          : word;
      }),
    };
  });
}

// ── Mark types ───────────────────────────────────────────────────────────────

/** Guessed types by `snapshot:blob`, as the server last suggested them. */
export type Expectations = Map<string, TypeSuggestion>;

export const expectationKey = (snapshot: string, blob: number) => `${snapshot}:${blob}`;

export function expectationsOf(suggestions: TypeSuggestion[]): Expectations {
  return new Map(
    suggestions.map((found) => [expectationKey(found.snapshot_id, found.blob_id), found]),
  );
}

/** A mark a person typed, or the text did — the only kinds a type is ever learned
 * from. A type stored without `subtype_explicit` predates the flag, when every type
 * was set by hand. */
export function isTyped(blob: CalibrationBlob): boolean {
  return (
    blob.role === "mark" &&
    !!blob.subtype &&
    (blob.subtype_explicit !== false || blob.subtype_source === "text")
  );
}

/** A mark whose type the text set, and nobody has typed since. */
export function typedByText(blob: CalibrationBlob): boolean {
  return (
    blob.role === "mark" &&
    !!blob.subtype &&
    blob.subtype_source === "text" &&
    !blob.subtype_explicit
  );
}

/** Who answered the engine's doubt about a blob — its score in the contested band, or
 * its first guess overruled by the count — so that the server no longer asks for a
 * look: the confirmed examples, agreeing with its role, or the text. Null when the
 * engine had no doubt, a person decided, or nothing answered it. */
export function answeredBy(blob: CalibrationBlob): "examples" | "text" | null {
  if (!isText(blob) || blob.explicit || blob.ownership_explicit) return null;
  const doubted = (blob.body_score >= 6 && blob.body_score <= 9) || blob.role !== blob.initial_role;
  if (!doubted) return null;
  if (blob.decision_source === "text") return "text";
  return blob.proposed_role === blob.role ? "examples" : null;
}

/** What a mark is expected to be: the latest guess, else a guess stored but never
 * accepted. Null for a typed mark, a body, and a mark nothing resembles yet. */
export function expectedType(
  blob: CalibrationBlob,
  snapshot: string,
  expectations: Expectations,
): { subtype: string; sure: boolean; confidence: number } | null {
  if (blob.role !== "mark" || isTyped(blob)) return null;
  const found = expectations.get(expectationKey(snapshot, blob.id));
  if (found) return found;
  return blob.subtype ? { subtype: blob.subtype, sure: false, confidence: 0 } : null;
}

/** Accept the expected types: the selected marks' (`selection`), every sure one on
 * the page (`"sure"`), or every one on the page a test lets through — the marks a
 * filter shows. Accepting is typing — the mark becomes an example once the page is
 * confirmed — so it is also a decision that the ink is a mark. */
export function acceptExpected(
  lines: CalibrationLine[],
  expectations: Expectations,
  scope: BlobSelection | "sure" | ((line: CalibrationLine, blob: CalibrationBlob) => boolean),
): CalibrationLine[] {
  const accept = (line: CalibrationLine, chosen: Set<number> | null) => {
    let changed = false;
    const blobs = line.blobs.map((blob) => {
      if (chosen && !chosen.has(blob.id)) return blob;
      if (typeof scope === "function" && !scope(line, blob)) return blob;
      const expected = expectedType(blob, line.snapshot_id, expectations);
      if (!expected || (scope === "sure" && !expected.sure)) return blob;
      changed = true;
      return {
        ...blob,
        subtype: expected.subtype,
        subtype_explicit: true,
        explicit: true,
        decision_source: "human" as const,
      };
    });
    return changed ? { ...line, blobs } : line;
  };
  if (scope === "sure" || typeof scope === "function")
    return lines.map((line) => (line.readonly ? line : accept(line, null)));
  return onLine(lines, scope, (line, chosen) => accept(line, chosen));
}

/** How far the page's typing has got. */
export function typeCounts(lines: CalibrationLine[], expectations: Expectations) {
  let marks = 0;
  let typed = 0;
  let expected = 0;
  let sure = 0;
  for (const line of lines) {
    if (line.readonly) continue;
    for (const blob of line.blobs) {
      if (blob.role !== "mark") continue;
      marks += 1;
      if (isTyped(blob)) typed += 1;
      const guess = expectedType(blob, line.snapshot_id, expectations);
      if (guess) {
        expected += 1;
        if (guess.sure) sure += 1;
      }
    }
  }
  return { marks, typed, expected, sure };
}

/** Everything the server's guesses depend on — which blobs are marks, and which are
 * typed as what. A change here asks for new guesses; dragging an edge does not. */
export function typingSignature(lines: CalibrationLine[]): string {
  return lines
    .filter((line) => !line.readonly)
    .map(
      (line) =>
        `${line.snapshot_id}:` +
        line.blobs
          .filter((blob) => blob.role === "mark")
          .map((blob) => (isTyped(blob) ? `${blob.id}=${blob.subtype}` : `${blob.id}`))
          .join(","),
    )
    .join("|");
}

// ── The text's check ─────────────────────────────────────────────────────────

/** Each word's marks against its text's, by `snapshot:word`, as the server last
 * checked them. */
export type MarkChecks = Map<string, WordMarkCheck>;

export const markCheckKey = (snapshot: string, word: number) => `${snapshot}:${word}`;

export function markChecksOf(words: WordMarkCheck[]): MarkChecks {
  return new Map(words.map((word) => [markCheckKey(word.snapshot_id, word.word_id), word]));
}

/** A word's check, when there is one. */
export function markCheckOf(
  snapshot: string,
  wordId: number | null,
  checks: MarkChecks,
): WordMarkCheck | null {
  return wordId === null ? null : (checks.get(markCheckKey(snapshot, wordId)) ?? null);
}

/** Strokes of a tanween, by `snapshot:blob` — each typed as the vowel it looks like,
 * shown as the tanween they make. */
export function tanweenOf(strokes: { snapshot_id: string; blob_id: number }[]): Set<string> {
  return new Set(strokes.map((stroke) => expectationKey(stroke.snapshot_id, stroke.blob_id)));
}

/** Doubts by `snapshot:blob`, as the server last raised them. */
export type Doubts = Map<string, TypeDoubt>;

export function doubtsOf(doubts: TypeDoubt[]): Doubts {
  return new Map(doubts.map((doubt) => [expectationKey(doubt.snapshot_id, doubt.blob_id), doubt]));
}

/** The doubt on a typed mark — only while it is still typed what was doubted: a
 * retyped mark waits for the next answer rather than showing the last one. */
export function doubtOf(blob: CalibrationBlob, snapshot: string, doubts: Doubts): TypeDoubt | null {
  if (!isTyped(blob)) return null;
  const found = doubts.get(expectationKey(snapshot, blob.id));
  return found && found.typed === blob.subtype ? found : null;
}

/** A mark's type as the page shows it: typed by a person, else expected. */
export function shownType(
  blob: CalibrationBlob,
  snapshot: string,
  expectations: Expectations,
): { subtype: string; typed: boolean; sure: boolean } | null {
  if (blob.role !== "mark") return null;
  if (isTyped(blob)) return { subtype: blob.subtype, typed: true, sure: true };
  const guess = expectedType(blob, snapshot, expectations);
  return guess ? { subtype: guess.subtype, typed: false, sure: guess.sure } : null;
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** Which blobs a click, a drag or an arrow key may pick. The kinds of mark —
 * a type, the untyped, the doubtful — also have the page show them, faded ink
 * around them (`highlights`). */
export type BlobFilter =
  | "all"
  | "body"
  | "mark"
  /** Marks typed, or else expected, as this type. */
  | `type:${string}`
  /** Marks nobody has typed yet, expected or not. */
  | "untyped"
  /** Typed marks the other pages' examples take for another type. */
  | "doubtful";

export const typeFilter = (subtype: string): BlobFilter => `type:${subtype}`;

/** Whether a filter picks out a kind of mark to show, not just what may be picked. */
export const highlights = (filter: BlobFilter): boolean =>
  filter !== "all" && filter !== "body" && filter !== "mark";

/** Whether a filter lets a blob through. Ornaments and symbols never pass. */
export function passesFilter(
  blob: CalibrationBlob,
  snapshot: string,
  filter: BlobFilter,
  expectations: Expectations,
  doubts: Doubts,
): boolean {
  if (!isText(blob)) return false;
  if (filter === "all") return true;
  if (filter === "body" || filter === "mark") return blob.role === filter;
  if (blob.role !== "mark") return false;
  if (filter === "untyped") return !isTyped(blob);
  if (filter === "doubtful") return doubtOf(blob, snapshot, doubts) !== null;
  return shownType(blob, snapshot, expectations)?.subtype === filter.slice("type:".length);
}

/** How the page's marks divide by type — for the filter's choices. */
export function typeTally(lines: CalibrationLine[], expectations: Expectations, doubts: Doubts) {
  const types = new Map<string, { typed: number; expected: number }>();
  let untyped = 0;
  let doubtful = 0;
  for (const line of lines) {
    if (line.readonly) continue;
    for (const blob of line.blobs) {
      const shown = shownType(blob, line.snapshot_id, expectations);
      if (blob.role === "mark" && !isTyped(blob)) untyped += 1;
      if (doubtOf(blob, line.snapshot_id, doubts)) doubtful += 1;
      if (!shown) continue;
      const entry = types.get(shown.subtype) ?? { typed: 0, expected: 0 };
      if (shown.typed) entry.typed += 1;
      else entry.expected += 1;
      types.set(shown.subtype, entry);
    }
  }
  return { types, untyped, doubtful };
}

// ── Moving through the page ──────────────────────────────────────────────────

type Placed = { line: CalibrationLine; blob: CalibrationBlob };

/** Every text blob of the editable lines in reading order: line by line, each right
 * to left by where the blob ends on the right — marks stacked over one spot, top
 * first. */
function readingOrder(lines: CalibrationLine[]): Placed[] {
  return lines
    .filter((line) => !line.readonly)
    .flatMap((line) =>
      line.blobs
        .filter(isText)
        .sort((a, b) => b.x + b.w - (a.x + a.w) || a.y - b.y || a.id - b.id)
        .map((blob) => ({ line, blob })),
    );
}

type Accept = (line: CalibrationLine, blob: CalibrationBlob) => boolean;

/** The next blob (`delta` 1 — leftwards, the way Arabic reads) or the previous one
 * that `accept` lets through, from the selection, across lines, wrapping at the
 * page's ends. From nothing selected: the first, or the last. Null when none passes. */
export function stepBlob(
  lines: CalibrationLine[],
  selection: BlobSelection,
  delta: 1 | -1,
  accept: Accept,
): BlobSelection | null {
  const order = readingOrder(lines);
  const passing = order
    .map((placed, rank) => ({ ...placed, rank }))
    .filter(({ line, blob }) => accept(line, blob));
  if (!passing.length) return null;
  const ranks = order.flatMap(({ line, blob }, rank) =>
    line.snapshot_id === selection.snapshot && selection.ids.includes(blob.id) ? [rank] : [],
  );
  let next;
  if (!ranks.length) next = delta === 1 ? passing[0] : passing[passing.length - 1];
  else if (delta === 1) {
    const from = Math.max(...ranks);
    next = passing.find(({ rank }) => rank > from) ?? passing[0];
  } else {
    const from = Math.min(...ranks);
    next = [...passing].reverse().find(({ rank }) => rank < from) ?? passing[passing.length - 1];
  }
  return { snapshot: next.line.snapshot_id, ids: [next.blob.id] };
}

/** The selection with the next blob in the direction added — on its own line only,
 * since a selection never spans lines. Unchanged at the line's end. */
export function extendSelection(
  lines: CalibrationLine[],
  selection: BlobSelection,
  delta: 1 | -1,
  accept: Accept,
): BlobSelection {
  if (!selection.ids.length) return stepBlob(lines, selection, delta, accept) ?? selection;
  const order = readingOrder(lines).filter(({ line }) => line.snapshot_id === selection.snapshot);
  const ranks = order.flatMap(({ blob }, rank) => (selection.ids.includes(blob.id) ? [rank] : []));
  if (!ranks.length) return selection;
  const ahead =
    delta === 1
      ? order.slice(Math.max(...ranks) + 1)
      : order.slice(0, Math.min(...ranks)).reverse();
  const next = ahead.find(
    ({ line, blob }) => !selection.ids.includes(blob.id) && accept(line, blob),
  );
  return next ? { ...selection, ids: [...selection.ids, next.blob.id] } : selection;
}

/** The blob `accept` lets through on the next line down (`delta` 1) or up that has
 * one, nearest across to the selection. Null past the first or last such line. */
export function stepLine(
  lines: CalibrationLine[],
  selection: BlobSelection,
  delta: 1 | -1,
  accept: Accept,
): BlobSelection | null {
  const editable = lines.filter((line) => !line.readonly);
  const at = editable.findIndex((line) => line.snapshot_id === selection.snapshot);
  const chosen = at < 0 ? [] : editable[at].blobs.filter((blob) => selection.ids.includes(blob.id));
  if (!chosen.length) return stepBlob(lines, selection, delta, accept);
  const across = chosen.reduce((sum, blob) => sum + blob.x + blob.w / 2, 0) / chosen.length;
  const distance = (blob: CalibrationBlob) => Math.abs(blob.x + blob.w / 2 - across);
  for (let i = at + delta; i >= 0 && i < editable.length; i += delta) {
    const line = editable[i];
    const candidates = line.blobs.filter((blob) => accept(line, blob));
    if (!candidates.length) continue;
    const nearest = candidates.reduce((best, blob) =>
      distance(blob) < distance(best) ? blob : best,
    );
    return { snapshot: line.snapshot_id, ids: [nearest.id] };
  }
  return null;
}

/** Every word of the editable lines that owns ink, in reading order: line by line,
 * each line's words as the text runs. */
function wordOrder(lines: CalibrationLine[]) {
  return lines
    .filter((line) => !line.readonly)
    .flatMap((line) =>
      line.words.flatMap((word, index) => {
        const ink = inkOf(line, word.word_id);
        return ink.length ? [{ line, index, ink }] : [];
      }),
    );
}

/** The word the selection is in — its index in `line.words`, or null: the word whose
 * ink is exactly the selection (so a word sharing a body with its neighbour is still
 * itself), else the first selected blob's owner. */
export function wordAt(lines: CalibrationLine[], selection: BlobSelection): number | null {
  const line = lines.find((candidate) => candidate.snapshot_id === selection.snapshot);
  if (!line || !selection.ids.length) return null;
  const chosen = new Set(selection.ids);
  const whole = line.words.findIndex((word) => {
    const ink = inkOf(line, word.word_id);
    return ink.length === chosen.size && ink.every((id) => chosen.has(id));
  });
  if (whole >= 0) return whole;
  const first = line.blobs.find((blob) => chosen.has(blob.id));
  if (!first?.allocations.length) return null;
  const owner = first.allocations[0].word_id;
  const index = line.words.findIndex((word) => word.word_id === owner);
  return index < 0 ? null : index;
}

/** All the ink of the next word (`delta` 1) or the previous one that `accept` lets
 * through, from the word the selection is in — across lines, wrapping at the page's
 * ends. From nothing: the first such word, or the last. Null when there is none. */
export function stepWord(
  lines: CalibrationLine[],
  selection: BlobSelection,
  delta: 1 | -1,
  accept: (line: CalibrationLine, word: CalibrationWord) => boolean = () => true,
): BlobSelection | null {
  const order = wordOrder(lines);
  const index = wordAt(lines, selection);
  const at =
    index === null
      ? -1
      : order.findIndex(
          (entry) => entry.line.snapshot_id === selection.snapshot && entry.index === index,
        );
  const n = order.length;
  for (let step = 1; step <= n; step++) {
    const i = at < 0 ? (delta === 1 ? step - 1 : n - step) : (((at + delta * step) % n) + n) % n;
    const entry = order[i];
    if (accept(entry.line, entry.line.words[entry.index]))
      return { snapshot: entry.line.snapshot_id, ids: entry.ink };
  }
  return null;
}

// ── What needs a look, word by word ──────────────────────────────────────────

/** Why a word deserves a look before the page is confirmed: its count does not
 * close, some of its ink asks for a look, its hand-set box reaches past its ink, its
 * line was not settled, or it owns no ink at all. Signals, never verdicts — a word
 * with none of them is not thereby right. */
export type WordRisk = "count" | "look" | "box" | "line" | "noInk" | "marks";

/** What about a word is worth a look — `marks` when its marks do not fit its text,
 * given the text's `checks`. */
export function wordRisks(
  line: CalibrationLine,
  word: CalibrationWord,
  checks?: MarkChecks,
): WordRisk[] {
  if (word.word_id === null) return [];
  const risks: WordRisk[] = [];
  const ink = line.blobs.filter((blob) =>
    blob.allocations.some((allocation) => allocation.word_id === word.word_id),
  );
  if (!ink.length) risks.push("noInk");
  else if (!wordCount(line, word).ok) risks.push("count");
  if (ink.some(needsLook)) risks.push("look");
  if (overshoot(line, word) > OVERSHOOT_PX) risks.push("box");
  if (line.status === "partial" || line.status === "unresolved") risks.push("line");
  const check = checks ? markCheckOf(line.snapshot_id, word.word_id, checks) : null;
  if (check && !check.ok) risks.push("marks");
  return risks;
}

/** The words a re-reading moved, by id: to another line, an edge by more than a
 * pixel, placed where it was not, or dropped. What a preview should point at. */
export function changedWords(before: CalibrationLine[], after: CalibrationLine[]): Set<number> {
  const places = (lines: CalibrationLine[]) => {
    const found = new Map<number, { snapshot: string; start: number; end: number }>();
    for (const line of lines) {
      if (line.readonly) continue;
      for (const word of line.words)
        if (word.word_id !== null)
          found.set(word.word_id, {
            snapshot: line.snapshot_id,
            start: word.start_x,
            end: word.end_x,
          });
    }
    return found;
  };
  const was = places(before);
  const now = places(after);
  const changed = new Set<number>();
  for (const [id, place] of now) {
    const old = was.get(id);
    if (
      !old ||
      old.snapshot !== place.snapshot ||
      Math.abs(old.start - place.start) > 1 ||
      Math.abs(old.end - place.end) > 1
    )
      changed.add(id);
  }
  for (const id of was.keys()) if (!now.has(id)) changed.add(id);
  return changed;
}

/** What confirming the page would teach later pages: its bodies and marks as examples
 * of their role, its typed marks as examples of their type — the server's `_eligible`
 * and `_typed`, counted. Ink flagged out of the ordinary teaches nothing, and neither
 * does a body standing for other than exactly one PAW. */
export function teaches(lines: CalibrationLine[]) {
  let bodies = 0;
  let marks = 0;
  let typed = 0;
  for (const line of lines) {
    if (line.readonly) continue;
    for (const blob of line.blobs) {
      if (!isText(blob) || blob.exception) continue;
      if (blob.role === "body") {
        const paws = blob.allocations.reduce((sum, allocation) => sum + allocation.paws, 0);
        if (!blob.allocations.length || paws === 1) bodies += 1;
      } else {
        marks += 1;
        if (isTyped(blob)) typed += 1;
      }
    }
  }
  return { bodies, marks, typed };
}

// ── The gallery ──────────────────────────────────────────────────────────────

/** The gallery shows the page's marks by type — or all its ink by role. */
export type GalleryKind = "types" | "roles";
export type GalleryItem = { line: CalibrationLine; blob: CalibrationBlob };
export type GalleryGroup = {
  /** A mark type ("" for marks with no type yet) — or "mark" / "body" by role. */
  key: string;
  items: GalleryItem[];
  /** Of a type's marks: typed by a person, and only expected. */
  typed: number;
  expected: number;
};

/** The text blobs the filter lets through, grouped so that each group is one look:
 * by the type each mark is (typed) or is expected to be — commonest first, marks with
 * no type last — or by role, marks then bodies. Within a group, what most needs a
 * look comes first: a doubt, then the least sure guess, then the sure ones, then the
 * typed; by role, the ink the engine found hardest to call — a mark that scored most
 * like a body, a body that scored most like a mark. Reading order breaks ties. */
export function galleryGroups(
  lines: CalibrationLine[],
  kind: GalleryKind,
  filter: BlobFilter,
  expectations: Expectations,
  doubts: Doubts,
): GalleryGroup[] {
  const groups = new Map<string, (GalleryItem & { rank: number; order: number })[]>();
  const counts = new Map<string, { typed: number; expected: number }>();
  readingOrder(lines).forEach(({ line, blob }, rank) => {
    if (!passesFilter(blob, line.snapshot_id, filter, expectations, doubts)) return;
    if (kind === "types" && blob.role !== "mark") return;
    let key: string = blob.role;
    let order = 0;
    if (kind === "types") {
      const shown = shownType(blob, line.snapshot_id, expectations);
      key = shown?.subtype ?? "";
      const tally = counts.get(key) ?? { typed: 0, expected: 0 };
      if (shown?.typed) tally.typed += 1;
      else if (shown) tally.expected += 1;
      counts.set(key, tally);
      order = doubtOf(blob, line.snapshot_id, doubts)
        ? 0
        : !shown
          ? 4
          : shown.typed
            ? 3
            : shown.sure
              ? 2
              : 1;
    } else {
      order = blob.role === "mark" ? -blob.body_score : blob.body_score;
    }
    const members = groups.get(key) ?? [];
    members.push({ line, blob, rank, order });
    groups.set(key, members);
  });
  const result = [...groups.entries()].map(([key, members]) => ({
    key,
    items: members
      .sort((a, b) => a.order - b.order || a.rank - b.rank)
      .map(({ line, blob }) => ({ line, blob })),
    typed: counts.get(key)?.typed ?? 0,
    expected: counts.get(key)?.expected ?? 0,
  }));
  return result.sort((a, b) =>
    kind === "roles"
      ? (a.key === "mark" ? 0 : 1) - (b.key === "mark" ? 0 : 1)
      : (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0) ||
        b.items.length - a.items.length ||
        a.key.localeCompare(b.key),
  );
}

/** The next gallery item (`delta` 1) or the previous one, wrapping; with `group`, the
 * first item of the next or previous group instead. From nothing: the first, or the
 * last. Null when the gallery is empty. */
export function stepGallery(
  groups: GalleryGroup[],
  selection: BlobSelection,
  delta: 1 | -1,
  group = false,
): BlobSelection | null {
  const items = groups.flatMap((entry, g) => entry.items.map((item) => ({ ...item, g })));
  if (!items.length) return null;
  const at = items.findIndex(
    (item) => item.line.snapshot_id === selection.snapshot && selection.ids.includes(item.blob.id),
  );
  let next;
  if (at < 0) next = items[delta === 1 ? 0 : items.length - 1];
  else if (!group) next = items[(at + delta + items.length) % items.length];
  else {
    const g = (items[at].g + delta + groups.length) % groups.length;
    next = items.find((item) => item.g === g)!;
  }
  return { snapshot: next.line.snapshot_id, ids: [next.blob.id] };
}

// ── The raster ───────────────────────────────────────────────────────────────

/** Blob ids from an RGBA pixel buffer of the labels image: id = R + 256·G + 65536·B.
 * Decoded once at the raster's own size; neither display scaling nor blob boxes
 * take part, so a click resolves to the pixel's own blob even where boxes overlap. */
export function decodeLabels(rgba: ArrayLike<number>): Uint32Array {
  const ids = new Uint32Array(Math.floor(rgba.length / 4));
  for (let i = 0; i < ids.length; i++) {
    const p = i * 4;
    ids[i] = rgba[p + 3] === 255 ? rgba[p] + rgba[p + 1] * 256 + rgba[p + 2] * 65536 : 0;
  }
  return ids;
}

export function labelAt(
  ids: Uint32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return ids[Math.floor(y) * width + Math.floor(x)] ?? 0;
}

/** Every blob with at least one pixel inside the rectangle (raster coordinates). */
export function labelsInRect(
  ids: Uint32Array,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number[] {
  const found = new Set<number>();
  const top = Math.max(0, Math.floor(Math.min(y1, y2)));
  const bottom = Math.min(height, Math.ceil(Math.max(y1, y2)));
  const left = Math.max(0, Math.floor(Math.min(x1, x2)));
  const right = Math.min(width, Math.ceil(Math.max(x1, x2)));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const id = ids[y * width + x];
      if (id) found.add(id);
    }
  }
  return [...found];
}

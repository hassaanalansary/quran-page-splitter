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
//   * nothing else sets a box: no edge is placed by hand, and a draft carries blob
//     decisions only — the server takes every box from the ink again.
import { cutFitsBlob, pieceOfWord, swapPieceOwner } from "./blobCuts.ts";
import { decidedOfBlob } from "./contents.ts";
import type {
  Allocation,
  BlobCut,
  BlobException,
  CalibrationBlob,
  CalibrationDocument,
  CalibrationDraft,
  CalibrationLine,
  CalibrationWord,
  NoiseSuspect,
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
        blobs: line.blobs.map((blob) => {
          const { id, ownership_explicit, exception, allocations, erased } = blob;
          return {
            id,
            decided: decidedOfBlob(blob),
            ownership_explicit,
            // Only what no key can say: marks inside a letter and pieces printed as one
            // are in the decided key.
            flag: exception === "broken" || exception === "uncertain" ? exception : "",
            allocations,
            erased: !!erased,
            // Only a cut that still fits travels; the server measures its pieces.
            cut: cutFitsBlob(blob) ? { lines: blob.cut.lines, owners: blob.cut.owners } : null,
          };
        }),
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
  /** Where it is, so the list can select it: the line, and the flagged blob or the
   * word that does not close. */
  snapshot?: string;
  blob_id?: number;
  word_id?: number;
};

export function pageExceptions(lines: CalibrationLine[]): PageException[] {
  const found: PageException[] = [];
  for (const line of lines) {
    if (line.readonly) continue;
    for (const blob of line.blobs) {
      if (blob.exception && !blob.erased)
        found.push({
          kind: "flagged",
          line_number: line.line_number,
          detail: blob.exception,
          snapshot: line.snapshot_id,
          blob_id: blob.id,
        });
    }
    for (const word of line.words) {
      const count = wordCount(line, word);
      if (!count.ok) {
        found.push({
          kind: "paw-count",
          line_number: line.line_number,
          detail: `${word.text}: ${count.got}/${count.want}`,
          snapshot: line.snapshot_id,
          word_id: word.word_id ?? undefined,
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

/** A blob the reviewer should look at: flagged by the server, or by them. Never an
 * erased one: it is no ink of the text. */
export function needsLook(blob: CalibrationBlob): boolean {
  if (blob.erased) return false;
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
 * A body shared with other words and cut with the knife gives the word the extent
 * of its own piece. Uncut, where it is shared with the word before (to the right, a
 * smaller id), the word starts at the body's middle; shared with the word after, it
 * ends there: the cut lies somewhere inside that one piece of ink, and its middle is
 * as near as ink alone can say. Null when the word has no ink of its own. */
export function edgesFromInk(
  line: CalibrationLine,
  wordId: number,
): { start_x: number; end_x: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const blob of line.blobs) {
    const ids = blob.allocations.map((allocation) => allocation.word_id);
    if (!isText(blob) || !ids.includes(wordId)) continue;
    const piece = cutFitsBlob(blob) ? pieceOfWord(blob.cut, wordId) : null;
    const middle = blob.x + Math.floor(blob.w / 2);
    const right = piece
      ? piece.x + piece.w
      : ids.some((id) => id < wordId)
        ? middle
        : blob.x + blob.w;
    const left = piece ? piece.x : ids.some((id) => id > wordId) ? middle : blob.x;
    start = start === null ? right : Math.max(start, right);
    end = end === null ? left : Math.min(end, left);
  }
  return start === null || end === null || start <= end ? null : { start_x: start, end_x: end };
}

/** Recalculate the named words' edges from the bodies and marks that belong to them
 * — the server's `_box_words`. A cut whose words or role changed under it goes
 * first, as the server drops it. A word left with no ink keeps its old edges (a box
 * needs numbers); its badge says 0 of N. */
function recalculate(edited: CalibrationLine, words: Set<number>): CalibrationLine {
  const line = dropCutsThatNoLongerFit(edited);
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
      const edges = edgesFromInk(line, id);
      return edges ? { ...word, shared, ...edges } : { ...word, shared };
    }),
  };
}

/** The line without the cuts that no longer fit their blobs — the server's
 * `drop_cuts_that_no_longer_fit`. The same line when every cut still fits. */
function dropCutsThatNoLongerFit(line: CalibrationLine): CalibrationLine {
  if (!line.blobs.some((blob) => blob.cut && !cutFitsBlob(blob))) return line;
  return {
    ...line,
    blobs: line.blobs.map((blob) =>
      !blob.cut || cutFitsBlob(blob) ? blob : { ...blob, cut: undefined },
    ),
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

/** Structure a person may call text: a blob the symbol pass took for a sajda or rub'
 * sign, or a piece grouped with an aya ornament — not its ring, which closes the aya.
 * It is read as text while they say so, and they may take that back (the server's
 * `calibration_structure`). */
export const canBeCalledText = (blob: CalibrationBlob) =>
  blob.initial_role === "symbol" || (blob.initial_role === "ornament" && blob.ring === false);

/** Structure a person called text, made structure again: out of every word, with none
 * of text's decisions. */
function makeStructureAgain(blob: CalibrationBlob): CalibrationBlob {
  return {
    ...blob,
    role: blob.initial_role,
    explicit: false,
    ownership_explicit: false,
    allocations: [],
    subtype: "",
    subtype_explicit: false,
    subtype_source: undefined,
    text_role: undefined,
    text_word: undefined,
    exception: "",
    attention: [],
    decision_source: "search",
    cut: undefined,
    ...(blob.erased === undefined ? {} : { erased: false }),
  };
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** Say what the selected blobs are. A decision, so it becomes a hard constraint.
 *
 * An ornament's ring keeps its role. A symbol, or another piece of an ornament,
 * becomes text, unowned until the next preview reads it with the rest of the line's
 * ink. A blob becoming a mark
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
      if (!chosen.has(blob.id) || !(isText(blob) || canBeCalledText(blob))) return blob;
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
    return recalculate({ ...line, blobs }, affected);
  });
}

/** Erase the selected blobs — noise the line's cutting left, not ink of the text —
 * or restore them. The server's `_erase`: an erased blob belongs to no word, has no
 * type, no flag and asks for no look; its role stays, for a restore. Restored, it is
 * ink again, unowned until the next preview reads it. The words it belonged to take
 * their boxes from the ink they have left. Ornaments and symbols are never erased. */
export function setErased(
  lines: CalibrationLine[],
  selection: BlobSelection,
  erased: boolean,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !isText(blob) || !!blob.erased === erased) return blob;
      if (!erased) return { ...blob, erased: false };
      ownersOf(blob).forEach((id) => affected.add(id));
      return {
        ...blob,
        erased: true,
        allocations: [],
        ownership_explicit: false,
        subtype: "",
        subtype_explicit: false,
        subtype_source: undefined,
        text_role: undefined,
        text_word: undefined,
        exception: "" as const,
        attention: [],
      };
    });
    return recalculate({ ...line, blobs }, affected);
  });
}

export function setException(
  lines: CalibrationLine[],
  selection: BlobSelection,
  exception: BlobException,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !isText(blob) || blob.erased) return blob;
      // A body no longer mixed holds no marks: the ones named in it go.
      return isFusedBody(blob) && exception !== "mixed"
        ? { ...blob, exception, exception_read: false, subtype: "", subtype_explicit: false }
        : { ...blob, exception, exception_read: false };
    }),
  }));
}

/** A body flagged mixed: a mark printed touching its letter, one blob with it. Its
 * `subtype` names the marks in it, which the word's check counts as its ink. */
export function isFusedBody(blob: CalibrationBlob): boolean {
  return blob.role === "body" && blob.exception === "mixed" && !blob.erased;
}

/** Name a mark in the selected mixed bodies, or take the name off again. */
export function toggleFusedMark(
  lines: CalibrationLine[],
  selection: BlobSelection,
  part: string,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !isFusedBody(blob)) return blob;
      const parts = subtypeParts(blob.subtype);
      const subtype = composeSubtype(
        parts.includes(part) ? parts.filter((other) => other !== part) : [...parts, part],
      );
      return { ...blob, subtype, subtype_explicit: !!subtype, exception_read: false };
    }),
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
      chosen.has(blob.id) && blob.role === "mark" && !blob.erased
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

// ── The labeling bar: what a blob holds, chip by chip ──────────────────────

/** A chip of the labeling bar: a mark the blob holds, or the run of its word's pieces
 * it holds — from `start` up to `end`, in reading order. */
export type ContentsChip =
  | { kind: "mark"; name: string }
  | { kind: "pieces"; wordId: number; start: number; end: number };

/** The run of its word's pieces one body holds: from `start` up to `end`. */
export type PieceRun = { id: number; start: number; end: number; shared: boolean };

/** Which of a word's pieces each of its bodies holds, as the reader lays them out
 * (`page_reader.read_words_of_row`): a body shared with the word before holds the
 * word's first pieces, one shared with the word after its last, and the others follow
 * one another right to left, each its allocated count. `first` and `last` bound what
 * the unshared bodies hold. Clamped to the word's `total`, so counts that do not
 * close still give runs. */
export function layWordPieces(
  line: CalibrationLine,
  wordId: number,
  total: number,
): { runs: PieceRun[]; first: number; last: number } {
  const bodies = line.blobs.filter(
    (blob) =>
      blob.role === "body" &&
      !blob.erased &&
      blob.allocations.some((allocation) => allocation.word_id === wordId),
  );
  const countOf = (blob: CalibrationBlob) =>
    blob.allocations.find((allocation) => allocation.word_id === wordId)?.paws ?? 0;
  const runs: PieceRun[] = [];
  let first = 0;
  let last = total;
  for (const blob of bodies.filter((body) => body.allocations.length > 1)) {
    const ids = blob.allocations.map((allocation) => allocation.word_id);
    if (wordId === Math.min(...ids)) {
      const start = Math.max(first, last - countOf(blob));
      runs.push({ id: blob.id, start, end: last, shared: true });
      last = start;
    } else {
      const end = Math.min(last, first + countOf(blob));
      runs.push({ id: blob.id, start: first, end, shared: true });
      first = end;
    }
  }
  let at = first;
  const alone = bodies
    .filter((body) => body.allocations.length === 1)
    .sort((a, b) => b.x + b.w - (a.x + a.w));
  for (const blob of alone) {
    const start = Math.min(at, last);
    at += countOf(blob);
    runs.push({ id: blob.id, start, end: Math.min(at, last), shared: false });
  }
  return { runs, first, last };
}

/** The run a click on piece `index` leaves a body holding, or null when it changes
 * nothing. A piece next to the run joins it (the body holds both, printed touching);
 * one at either end of a longer run leaves it; any other piece is held alone — so a
 * body the reading gave the wrong piece takes the right one in one click. */
export function nextPieceRun(start: number, end: number, index: number): [number, number] | null {
  if (end <= start) return [index, index + 1];
  if (index >= start && index < end) {
    if (end - start === 1) return null;
    if (index === start) return [start + 1, end];
    if (index === end - 1) return [start, end - 1];
    return [index, index + 1];
  }
  if (index === start - 1) return [index, end];
  if (index === end) return [start, end + 1];
  return [index, index + 1];
}

/** New counts for bodies that must hold `total` pieces between them, nearest the edited
 * body first, changing as little as it can: a body holding none is given one before
 * any is given more, the nearest takes the rest, and when there is less to go round
 * the nearest gives first, each keeping one while there are pieces enough. */
export function spreadPieces(counts: number[], total: number): number[] {
  const next = [...counts];
  let left = total - next.reduce((sum, count) => sum + count, 0);
  for (let index = 0; left > 0 && index < next.length; index += 1) {
    if (next[index] === 0) {
      next[index] = 1;
      left -= 1;
    }
  }
  if (left > 0 && next.length) next[0] += left;
  for (const keep of [total >= next.length ? 1 : 0, 0]) {
    for (let index = 0; left < 0 && index < next.length; index += 1) {
      const give = Math.min(next[index] - keep, -left);
      if (give > 0) {
        next[index] -= give;
        left += give;
      }
    }
  }
  return next;
}

/** A body given `letters` of its word: its allocation and its flag — and, when a person
 * chose them or had already decided what it holds, the letters as decided. The marks
 * the reading put in it go: they were read on other letters. */
function holdPieces(
  blob: CalibrationBlob,
  wordId: number,
  letters: string[],
  chosen: boolean,
): CalibrationBlob {
  const count = letters.length;
  const keep = chosen || blob.explicit || blob.ownership_explicit;
  const readMarks = blob.exception === "mixed" && !!blob.exception_read;
  const exception: BlobException =
    blob.exception === "broken" || blob.exception === "uncertain"
      ? blob.exception
      : blob.exception === "mixed" && !readMarks
        ? "mixed"
        : count > 1
          ? "fused"
          : "";
  return {
    ...blob,
    allocations: [{ word_id: wordId, paws: count }],
    exception,
    exception_read: !keep && exception === "fused",
    subtype: readMarks ? "" : blob.subtype,
    subtype_explicit: readMarks ? false : blob.subtype_explicit,
    ...(keep
      ? {
          explicit: true,
          ownership_explicit: true,
          decided: { paws: count ? letters : [null], marks: blob.decided?.marks ?? null },
        }
      : {}),
    ...(chosen ? { decision_source: "human" as const } : {}),
  };
}

/** Give the one selected body the run of its word's pieces a chip chose, and lay the
 * word's other bodies around it — those before it hold the pieces before the run,
 * those after the pieces after — so the word's pieces are each held once. */
function choosePieces(
  lines: CalibrationLine[],
  selection: BlobSelection,
  chip: Extract<ContentsChip, { kind: "pieces" }>,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const pieces = line.words.find((word) => word.word_id === chip.wordId)?.pieces ?? [];
    const target = line.blobs.find((blob) => chosen.has(blob.id));
    if (
      chosen.size !== 1 ||
      !target ||
      target.role !== "body" ||
      target.erased ||
      target.allocations.length !== 1 ||
      target.allocations[0].word_id !== chip.wordId ||
      !pieces.length
    )
      return line;
    const { runs, first, last } = layWordPieces(line, chip.wordId, pieces.length);
    const alone = runs.filter((run) => !run.shared);
    const at = alone.findIndex((run) => run.id === target.id);
    const start = Math.max(first, chip.start);
    const end = Math.min(last, chip.end);
    if (at < 0 || end <= start) return line;
    const counts = alone.map((run) => run.end - run.start);
    const before = spreadPieces(counts.slice(0, at).reverse(), start - first).reverse();
    const after = spreadPieces(counts.slice(at + 1), last - end);
    const letters = new Map<number, string[]>([[target.id, pieces.slice(start, end)]]);
    let cursor = first;
    alone.slice(0, at).forEach((run, index) => {
      letters.set(run.id, pieces.slice(cursor, cursor + before[index]));
      cursor += before[index];
    });
    cursor = end;
    alone.slice(at + 1).forEach((run, index) => {
      letters.set(run.id, pieces.slice(cursor, cursor + after[index]));
      cursor += after[index];
    });
    const blobs = line.blobs.map((blob) => {
      const held = letters.get(blob.id);
      if (!held) return blob;
      if (blob.id === target.id) return holdPieces(blob, chip.wordId, held, true);
      return held.length === blob.allocations[0].paws
        ? blob
        : holdPieces(blob, chip.wordId, held, false);
    });
    return recalculate({ ...line, blobs }, new Set([chip.wordId]));
  });
}

/** Tick or untick a chip on the selected text blob — one edit, a person's decision.
 *
 * A mark chip on a mark types it; on a body it names a mark printed touching its letter
 * (the body is then "mixed"), or takes the name off — and a body whose marks were all
 * taken off is decided to hold none, so the next reading does not claim one again. A
 * pieces chip gives the body that run of its word's pieces ("fused" above one), and
 * the word's other bodies the rest (`choosePieces`). */
export function applyContentsChip(
  lines: CalibrationLine[],
  selection: BlobSelection,
  chip: ContentsChip,
): CalibrationLine[] {
  if (chip.kind === "pieces") return choosePieces(lines, selection, chip);
  return onLine(lines, selection, (line, chosen) => ({
    ...line,
    blobs: line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !isText(blob) || blob.erased) return blob;
      if (blob.role === "mark") {
        return {
          ...blob,
          subtype: chip.name,
          subtype_explicit: true,
          subtype_source: undefined,
          explicit: true,
          decision_source: "human" as const,
        };
      }
      // The chips show what it holds, read or decided; a click turns the one clicked.
      const parts = blob.exception === "mixed" ? subtypeParts(blob.subtype) : [];
      const next = parts.includes(chip.name)
        ? parts.filter((part) => part !== chip.name)
        : [...parts, chip.name];
      const subtype = composeSubtype(next);
      return {
        ...blob,
        explicit: true,
        decision_source: "human" as const,
        exception: subtype
          ? ("mixed" as const)
          : blob.exception === "mixed"
            ? ("" as const)
            : blob.exception,
        exception_read: false,
        subtype,
        subtype_explicit: true,
        subtype_source: undefined,
      };
    }),
  }));
}

// ── Pairs: marks printed as one ────────────────────────────────────────────

/** The order a pair's names are written in — the server's `mark_check.COMPOUND_ORDER`,
 * so both name a hamza printed with its kasra "hamza+kasra". */
export const COMPOUND_ORDER: readonly string[] = [
  "hamza",
  "kafCurl",
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
  "smallWaw",
  "smallYa",
  "smallMeem",
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
    return recalculate({ ...line, blobs }, affected);
  });
}

/** Take the reviewer's decisions off the selected blobs: the next preview is free to
 * read them again. Their current role and allocations stay until it does — except
 * structure a person called text, which is text only while somebody says so: it is
 * structure again at once, and its words lose it. */
export function releaseDecisions(
  lines: CalibrationLine[],
  selection: BlobSelection,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id)) return blob;
      if (canBeCalledText(blob) && isText(blob)) {
        ownersOf(blob).forEach((id) => affected.add(id));
        return makeStructureAgain(blob);
      }
      // A body's contents go back to the reading too: its pieces, and the marks touching
      // it, are shown as read and no longer sent. A mark keeps its type.
      const body = blob.role === "body";
      return {
        ...blob,
        explicit: false,
        ownership_explicit: false,
        decided: body ? null : blob.decided,
        subtype_explicit: body ? false : blob.subtype_explicit,
        exception_read:
          blob.exception === "mixed" || blob.exception === "fused" ? true : blob.exception_read,
        decision_source: "search" as const,
      };
    });
    return recalculate({ ...line, blobs }, affected);
  });
}

/** Give the selected structure a person called text back to what measurement said
 * it is — a symbol, or a piece of its ornament: the reading leaves it out, and the
 * words it was given lose it. */
export function giveBackToStructure(
  lines: CalibrationLine[],
  selection: BlobSelection,
): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !canBeCalledText(blob) || !isText(blob)) return blob;
      ownersOf(blob).forEach((id) => affected.add(id));
      return makeStructureAgain(blob);
    });
    return recalculate({ ...line, blobs }, affected);
  });
}

/** Give the selected blobs to one word.
 *
 * Bodies carry `paws` each (1 an ordinary letter piece, 0 a broken fragment, 2 two
 * bodies printed touching); marks carry none. This records ownership — it does not
 * change anybody's role. Every word that gained or lost ink takes its box from its
 * ink again. */
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
      if (!chosen.has(blob.id) || !isText(blob) || blob.erased) return blob;
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
    return recalculate({ ...line, blobs }, new Set([...affected, ...markWords]));
  });
}

/** One body printed touching across a word break: it belongs to both words.
 *
 * Each word is given its own share of the blob's PAWs, so both counts close on
 * their own. The alignment reads the joined words as one unit and splits them
 * again at this blob. Between them the blob divides at its middle until a person
 * cuts it with the knife (`cutBlob`); a cut stays while the same words share it. */
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
      if (!chosen.has(blob.id) || blob.role !== "body" || blob.erased) return blob;
      ownersOf(blob).forEach((id) => affected.add(id));
      return {
        ...blob,
        allocations: valid.map((share) => ({ ...share })),
        ownership_explicit: true,
      };
    });
    return recalculate({ ...line, blobs }, affected);
  });
}

// ── The knife: a shared body cut into one piece per word ─────────────────────

/** Change one blob of one editable line, and recalculate the words it is shared by. */
function onBlob(
  lines: CalibrationLine[],
  snapshot: string,
  blobId: number,
  edit: (blob: CalibrationBlob) => CalibrationBlob | null,
): CalibrationLine[] {
  return lines.map((line) => {
    if (line.readonly || line.snapshot_id !== snapshot) return line;
    const target = line.blobs.find((blob) => blob.id === blobId);
    const next = target ? edit(target) : null;
    if (!target || !next) return line;
    const blobs = line.blobs.map((blob) => (blob.id === blobId ? next : blob));
    return recalculate({ ...line, blobs }, new Set(ownersOf(next)));
  });
}

/** Cut a shared body with the knife: the lines a person drew, each piece's word, and
 * the pieces as the editor measured them (the server measures them again). Refused —
 * the lines unchanged — unless the blob is a body shared by exactly those words and
 * there is one piece per word. */
export function cutBlob(
  lines: CalibrationLine[],
  snapshot: string,
  blobId: number,
  cut: BlobCut,
): CalibrationLine[] {
  return onBlob(lines, snapshot, blobId, (blob) => {
    const next = { ...blob, cut: { ...cut, lines: [...cut.lines], owners: [...cut.owners] } };
    return cutFitsBlob(next) ? next : null;
  });
}

/** Give the clicked piece of a cut blob the next piece's word, and that piece its
 * word: with two pieces, the swap. */
export function swapCutPiece(
  lines: CalibrationLine[],
  snapshot: string,
  blobId: number,
  piece: number,
): CalibrationLine[] {
  return onBlob(lines, snapshot, blobId, (blob) =>
    cutFitsBlob(blob)
      ? { ...blob, cut: { ...blob.cut, owners: swapPieceOwner(blob.cut.owners, piece) } }
      : null,
  );
}

/** Take the knife's cut off the selected blobs: their words divide them at the
 * middle again. */
export function clearCut(lines: CalibrationLine[], selection: BlobSelection): CalibrationLine[] {
  return onLine(lines, selection, (line, chosen) => {
    const affected = new Set<number>();
    const blobs = line.blobs.map((blob) => {
      if (!chosen.has(blob.id) || !blob.cut) return blob;
      ownersOf(blob).forEach((id) => affected.add(id));
      return { ...blob, cut: undefined };
    });
    return affected.size ? recalculate({ ...line, blobs }, affected) : line;
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
    !blob.erased &&
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
  if (!isText(blob) || blob.erased || blob.explicit || blob.ownership_explicit) return null;
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
  if (blob.role !== "mark" || blob.erased || isTyped(blob)) return null;
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
      if (blob.role !== "mark" || blob.erased) continue;
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

/** Everything the server's guesses depend on — which blobs are marks, which are
 * typed as what, which are erased, and the marks named in a mixed body. A change here
 * asks for new guesses; giving ink to another word does not. */
export function typingSignature(lines: CalibrationLine[]): string {
  return lines
    .filter((line) => !line.readonly)
    .map(
      (line) =>
        `${line.snapshot_id}:` +
        line.blobs
          .filter((blob) => blob.role === "mark" || blob.erased || isFusedBody(blob))
          .map((blob) =>
            blob.erased
              ? `${blob.id}x`
              : isFusedBody(blob)
                ? `${blob.id}~${blob.subtype}`
                : isTyped(blob)
                  ? `${blob.id}=${blob.subtype}`
                  : `${blob.id}`,
          )
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

/** Marks that may be noise the line's cutting left, by `snapshot:blob`, as the server
 * last found them. */
export type NoiseSuspects = Map<string, NoiseSuspect>;

export function noiseOf(found: NoiseSuspect[]): NoiseSuspects {
  return new Map(found.map((item) => [expectationKey(item.snapshot_id, item.blob_id), item]));
}

/** Why a blob may be noise — only while it is still ink: an erased one is settled. */
export function noiseFor(
  blob: CalibrationBlob,
  snapshot: string,
  noise: NoiseSuspects,
): NoiseSuspect | null {
  if (blob.erased) return null;
  return noise.get(expectationKey(snapshot, blob.id)) ?? null;
}

/** A mark's type as the page shows it: typed by a person, else expected. */
export function shownType(
  blob: CalibrationBlob,
  snapshot: string,
  expectations: Expectations,
): { subtype: string; typed: boolean; sure: boolean } | null {
  if (blob.role !== "mark" || blob.erased) return null;
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

/** Whether a filter lets a blob through. An ornament's ring never passes; a symbol,
 * or another piece of an ornament, passes only the filter that shows everything, to
 * be picked and called text. */
export function passesFilter(
  blob: CalibrationBlob,
  snapshot: string,
  filter: BlobFilter,
  expectations: Expectations,
  doubts: Doubts,
): boolean {
  if (!isText(blob)) return canBeCalledText(blob) && filter === "all";
  if (filter === "all") return true;
  if (filter === "body" || filter === "mark") return blob.role === filter;
  // Erased ink is no kind of mark — but still picked by role, to be restored.
  if (blob.erased) return false;
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
      if (blob.role === "mark" && !blob.erased && !isTyped(blob)) untyped += 1;
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
 * close, some of its ink asks for a look, its line was not settled, or it owns no ink
 * at all. Signals, never verdicts — a word with none of them is not thereby right. */
export type WordRisk = "count" | "look" | "line" | "noInk" | "marks";

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
 * and `_typed`, counted. Ink flagged out of the ordinary teaches nothing, nor does ink
 * erased, nor a body standing for other than exactly one PAW. */
export function teaches(lines: CalibrationLine[]) {
  let bodies = 0;
  let marks = 0;
  let typed = 0;
  for (const line of lines) {
    if (line.readonly) continue;
    for (const blob of line.blobs) {
      if (!isText(blob) || blob.exception || blob.erased) continue;
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
    if (blob.erased || (kind === "types" && blob.role !== "mark")) return;
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

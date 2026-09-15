// The editable model behind the Words step, and the one rule that keeps it honest.
//
// Pure — no React, no fetching. `src/lib/review/recompute.ts` plays the same role
// for the Review step.
//
// EVERYTHING HERE IS IN PAGE PIXELS. `LineWord.end_x`, `Line.bbox_*` and
// `Segment.bbox_*` all live in the coordinate space of the image pageImageUrl()
// serves, so drawing needs no conversion. The engine's own image-x coordinates are
// bridged server-side (save_word_coordinates adds PlacedLine.origin_x) and never
// reach the client.
import type { Line, LineType, LineWords, PageWords, Rect, WordLineStatus } from "@/lib/api";

/** One word's box on a line, drawn `start_x`..`end_x` across the line's height.
 *
 * Arabic runs right to left, so **`start_x` is the LARGER number** — a word starts at
 * its right edge. Neither edge says which word it is: the array's order is the
 * reading order and the only thing that decides it.
 *
 * Boxes do not tile the line, and may overlap where a tail sweeps under a
 * neighbour. */
export type EditCut = {
  /** Stable identity across edits. A word_id cannot serve: renumbering changes it. */
  uid: string;
  word_id: number | null;
  /** Display only, refreshed from the page's label map after every renumber. */
  text: string;
  aya: string;
  /** The word's RIGHT edge — larger than `end_x`. */
  start_x: number;
  end_x: number;
  /** The reviewer says this cut has no word in the stored text — a riwaya printing
   * something Hafs does not. Skipped by the renumber, so it never eats an id. */
  unlabelled: boolean;
};

export type EditLine = {
  line_id: string;
  line_number: number;
  type: LineType;
  /** The line's own box, which is the crop each strip is drawn from. */
  bbox: Rect;
  status: WordLineStatus | null;
  reason: string;
  deviations: number;
  ties: number;
  edited: boolean;
  /** Ornament left edges on this line, page x, right to left. Kept for the
   * "does the ornament count agree" cross-check; `stretches` no longer splits on
   * them, because that read the answer off the picture. */
  anchors: number[];
  /** Reading order — the order the server sent, never re-sorted by `end_x`. */
  cuts: EditCut[];
};

/** Word id → its text and aya, as the server last reported them. Renumbering moves
 * ids around, and this is what lets a moved cut still show the right word without a
 * round trip. A miss (the id ran off the end of the page) shows blank, which is
 * honest — the next save refills it. */
export type LabelMap = Map<number, { text: string; aya: string }>;

/** The word ids one stretch is pinned to, captured when the page was loaded.
 * Null at an end the page does not close — a stretch running off the top or bottom
 * with no ornament is pinned on one side only. */
export type StretchPin = { first: number | null; last: number | null };

export type WordsModel = {
  lines: EditLine[];
  labels: LabelMap;
  /** One per stretch, by position. A stretch is an aya, and adding or deleting a
   * cut never adds or removes an aya — so the index is stable across every edit,
   * which is what makes these usable as pins at all. */
  pins: StretchPin[];
};

/** One aya's run of cuts, as slots into `lines`. */
export type Stretch = {
  index: number;
  slots: { line: number; cut: number }[];
  /** Cuts drawn vs words the pinned range demands. Unequal is the reviewer's cue. */
  cuts: number;
  words: number;
};

let seq = 0;
function uid(): string {
  seq += 1;
  return `c${seq}`;
}

/** Only text lines carry words; a sura header or a besmella has none, and counting
 * them would make every page look permanently incomplete (the same exclusion
 * `coverage` makes server-side). They are still drawn, just never edited. */
export function holdsWords(line: { type: LineType }): boolean {
  return line.type === "text";
}

// ── Building ─────────────────────────────────────────────────────────────────

/** Join the words payload to the page's geometry. The two are keyed by the same
 * line id: `LineSchema.id` from GET pages/{n}, `line_id` from GET .../words. */
export function buildModel(words: PageWords | undefined, page: Line[] | undefined): WordsModel {
  if (!words || !page) return { lines: [], labels: new Map(), pins: [] };

  const geometry = new Map(page.filter((l) => l.id).map((l) => [l.id!, l] as const));
  const labels: LabelMap = new Map();

  const lines: EditLine[] = [];
  for (const row of words.lines) {
    const geo = geometry.get(row.line_id);
    if (!geo) continue;
    for (const w of row.words) {
      if (w.word_id != null) labels.set(w.word_id, { text: w.text, aya: w.aya });
    }
    lines.push({
      line_id: row.line_id,
      line_number: row.line_number,
      type: geo.type,
      bbox: { x: geo.bbox_x, y: geo.bbox_y, w: geo.bbox_w, h: geo.bbox_h },
      status: row.status,
      reason: row.reason,
      deviations: row.deviations,
      ties: row.ties,
      edited: row.edited,
      anchors: geo.segments
        .filter((s) => s.has_separator)
        .map((s) => s.bbox_x)
        .sort((a, b) => b - a),
      cuts: cutsOf(row),
    });
  }
  lines.sort((a, b) => a.line_number - b.line_number);
  return { lines, labels, pins: pinsOf(lines) };
}

/** The server's order, kept. Never re-sorted by `end_x`: that is where the cut sits,
 * not which word it is, and a badly read line comes back with the two disagreeing. */
function cutsOf(row: LineWords): EditCut[] {
  return row.words.map((w) => ({
    uid: uid(),
    word_id: w.word_id,
    text: w.text,
    aya: w.aya,
    start_x: w.start_x,
    end_x: w.end_x,
    unlabelled: w.word_id == null,
  }));
}

/** The pinned range of every stretch, read off the labels the engine wrote.
 *
 * Those labels are trustworthy exactly at the stretch boundaries: `parse_line`
 * re-pins its cursor at every ornament (`cursor = require_end`), so a desync
 * cannot survive one. What sits between two anchors is what an edit may shift. */
function pinsOf(lines: EditLine[]): StretchPin[] {
  return stretches(lines).map((stretch) => {
    const ids = stretch.slots
      .map(({ line, cut }) => lines[line].cuts[cut].word_id)
      .filter((id): id is number => id != null);
    return ids.length ? { first: ids[0], last: ids[ids.length - 1] } : { first: null, last: null };
  });
}

// ── Stretches ────────────────────────────────────────────────────────────────

/** Split the page's cuts into aya-delimited runs, in reading order.
 *
 * An ornament closes an aya, so a stretch is an aya's words — and which aya a word
 * belongs to comes from `word_id`, which is reference data. This used to walk the
 * cuts in descending `end_x` and split them at each ornament's page x. That reads
 * the same answer off the picture, and the picture is exactly what a bad reading
 * gets wrong: cuts out of order along the line fell into the wrong stretches, and
 * the renumber then worked on the wrong set.
 *
 * An unlabelled cut has no aya of its own and joins the stretch it sits in.
 */
export function stretches(lines: EditLine[]): Stretch[] {
  const out: Stretch[] = [];
  let slots: Stretch["slots"] = [];
  let aya: string | null = null;
  const flush = () => {
    out.push({ index: out.length, slots, cuts: slots.length, words: 0 });
    slots = [];
  };
  lines.forEach((line, li) => {
    if (!holdsWords(line)) return;
    line.cuts.forEach((cut, ci) => {
      // Labelled and in a new aya: the ornament that closed the last one sits here.
      if (cut.aya && aya !== null && cut.aya !== aya) flush();
      if (cut.aya) aya = cut.aya;
      slots.push({ line: li, cut: ci });
    });
  });
  flush();
  return out;
}

/** Stretches with their pinned word counts filled in, for the "N cuts / M words"
 * badge. Unequal means the reviewer has drawn more or fewer boundaries than the
 * ayat either side of this run leave room for. */
export function stretchesWithCounts(model: WordsModel): Stretch[] {
  return stretches(model.lines).map((s) => {
    const pin = model.pins[s.index];
    const words = pin && pin.first != null && pin.last != null ? pin.last - pin.first + 1 : 0;
    return { ...s, words };
  });
}

// ── The renumber rule ────────────────────────────────────────────────────────

/**
 * Reassign every word id on the page from the stretch pins.
 *
 * This is what turns three geometric gestures into correct data. When the engine
 * reads one mark as a letter it spends a word too many, and everything after it
 * shifts across the line break — so the fix is "word 108 belongs to line 11, not
 * line 10", and the reviewer expresses it by deleting one cut. The labels follow
 * from here.
 *
 * The cascade stops at the next ornament because the engine's own does: the
 * labels after it were re-pinned and are already right.
 *
 * Counts that do not close are left visible rather than absorbed — a stretch with
 * more cuts than words gets nulls at its end, one with fewer simply ends early,
 * and `stretchesWithCounts` badges both. The server reports the same thing as a
 * coherence issue on save.
 */
export function renumber(model: WordsModel): EditLine[] {
  const lines = model.lines.map((l) => ({ ...l, cuts: l.cuts.map((c) => ({ ...c })) }));
  for (const stretch of stretches(lines)) {
    const pin = model.pins[stretch.index];
    let next = pin?.first ?? null;
    for (const { line, cut } of stretch.slots) {
      const target = lines[line].cuts[cut];
      if (target.unlabelled || next == null || (pin?.last != null && next > pin.last)) {
        target.word_id = null;
        target.text = "";
        target.aya = "";
        continue;
      }
      target.word_id = next;
      const label = model.labels.get(next);
      target.text = label?.text ?? "";
      target.aya = label?.aya ?? "";
      next += 1;
    }
  }
  return lines;
}

// ── Editing ──────────────────────────────────────────────────────────────────

/** The narrowest a box may be dragged, in page px. Small enough to sit inside one
 * letter, wide enough that both edges stay grabbable. */
export const MIN_BOX_WIDTH = 4;

/** Clamp an x inside the line's own box, so no edge can land off the line. */
function clampX(line: EditLine, x: number): number {
  return Math.round(Math.max(line.bbox.x, Math.min(line.bbox.x + line.bbox.w, x)));
}

/** The box `x` falls inside, by index, or -1.
 *
 * Read off the *stored* order rather than by sorting, so a line whose boxes sit out
 * of order still splits the one actually under the pointer. Boxes may overlap; the
 * first match in reading order wins, which is the one drawn on top.
 */
function boxAt(line: EditLine, x: number): number {
  return line.cuts.findIndex((c) => c.end_x <= x && x <= c.start_x);
}

/**
 * Split the box `x` falls inside, at `x`.
 *
 * The right half keeps the original word and the left half becomes a new one, which
 * **takes the next word of the sequence**: the engine merged two words, so this line
 * holds one more than it drew, and the renumber pulls one in and shifts the rest
 * along. A word the stored text does not have is a different thing — `addExtraWord`.
 *
 * Nothing happens when `x` lands in the gap *between* two words. There is no box to
 * split there, and inventing one would be a guess about which neighbour it came
 * from; the panel's explicit insert is how a word goes into a gap.
 */
export function addCut(model: WordsModel, lineId: string, x: number): WordsModel | null {
  const index = model.lines.findIndex((l) => l.line_id === lineId);
  if (index < 0 || !holdsWords(model.lines[index])) return null;
  const line = model.lines[index];
  const cut = clampX(line, x);
  const at = boxAt(line, cut);
  if (at < 0) return null;

  const box = line.cuts[at];
  if (cut - box.end_x < MIN_BOX_WIDTH || box.start_x - cut < MIN_BOX_WIDTH) return null;

  const right: EditCut = { ...box, end_x: cut };
  const left: EditCut = { ...box, uid: uid(), word_id: null, text: "", aya: "", start_x: cut };
  const lines = model.lines.map((l, i) =>
    i === index
      ? { ...l, cuts: [...l.cuts.slice(0, at), right, left, ...l.cuts.slice(at + 1)] }
      : l,
  );
  return withRenumber({ ...model, lines });
}

/** Insert a word after `afterUid`, taking the next word of the text.
 *
 * The panel's way in, for a word the engine missed where double-clicking cannot
 * reach: in the gap *between* two boxes there is nothing to split, and guessing
 * which neighbour a click there belongs to would invent or lose a word. Naming the
 * word it follows says it exactly.
 *
 * It arrives **labelled**, like any other word — the renumber pulls the next id in
 * and shifts the rest along. A word this riwaya prints and the stored text does not
 * is then one toggle away: mark it with `toggleUnlabelled` and it gives its id back.
 */
export function insertWordAfter(
  model: WordsModel,
  lineId: string,
  afterUid: string | null,
): WordsModel | null {
  const index = model.lines.findIndex((l) => l.line_id === lineId);
  if (index < 0 || !holdsWords(model.lines[index])) return null;
  const line = model.lines[index];
  const at = afterUid === null ? 0 : line.cuts.findIndex((c) => c.uid === afterUid) + 1;
  if (at <= 0 && afterUid !== null) return null;

  // Fill the gap it is inserted into, so it arrives somewhere visible and sensible;
  // the reviewer drags its edges from there. A gap too small to see gets a token
  // box around the midpoint instead.
  const before = line.cuts[at - 1];
  const after = line.cuts[at];
  const start = before ? before.end_x : line.bbox.x + line.bbox.w;
  const end = after ? after.start_x : line.bbox.x;
  const middle = Math.round((start + end) / 2);
  const span =
    start - end >= MIN_BOX_WIDTH
      ? { start_x: start, end_x: end }
      : {
          start_x: clampX(line, middle + MIN_BOX_WIDTH * 4),
          end_x: clampX(line, middle - MIN_BOX_WIDTH * 4),
        };
  const cut: EditCut = {
    uid: uid(),
    word_id: null,
    text: "",
    aya: "",
    unlabelled: false,
    ...span,
  };
  const lines = model.lines.map((l, i) =>
    i === index ? { ...l, cuts: [...l.cuts.slice(0, at), cut, ...l.cuts.slice(at)] } : l,
  );
  return withRenumber({ ...model, lines });
}

/** Remove a box, handing its span to the neighbour.
 *
 * A removal says the engine invented that split, so the ink the box covered belongs
 * to the word beside it — leaving a hole would put that ink under no box at all. The
 * span goes to the word before it in reading order, or to the one after when the
 * first box on the line is removed.
 */
export function removeCut(model: WordsModel, lineId: string, cutUid: string): WordsModel {
  const lines = model.lines.map((l) => {
    if (l.line_id !== lineId) return l;
    const at = l.cuts.findIndex((c) => c.uid === cutUid);
    if (at < 0) return l;
    const gone = l.cuts[at];
    const cuts = l.cuts
      .filter((_, i) => i !== at)
      .map((c, i) => {
        if (at > 0 && i === at - 1) return { ...c, end_x: Math.min(c.end_x, gone.end_x) };
        if (at === 0 && i === 0) return { ...c, start_x: Math.max(c.start_x, gone.start_x) };
        return c;
      });
    return { ...l, cuts };
  });
  return withRenumber({ ...model, lines });
}

/** Which part of a box a drag has hold of. */
export type BoxHandle = "start" | "end" | "box";

/** Where a whole-box drag began, so the box slides with the pointer rather than
 * jumping to centre itself on it. */
export type BoxGrab = { start_x: number; end_x: number; at: number };

/**
 * Move one edge of a box, or slide the whole box. **Nothing is reordered and nothing
 * renumbers.**
 *
 * This is the point of storing the order: dragging changes where a word sits, never
 * which word it is. Re-sorting here would relabel every box the drag passed, so a
 * reviewer straightening out a badly read line would scramble it further with each
 * pull. The two edges cannot cross — a box thinner than `MIN_BOX_WIDTH` has nothing
 * left to grab — but a box may freely overlap its neighbours, because the ink does.
 */
export function moveBox(
  model: WordsModel,
  lineId: string,
  cutUid: string,
  handle: BoxHandle,
  x: number,
  grab?: BoxGrab,
): WordsModel | null {
  const line = model.lines.find((l) => l.line_id === lineId);
  if (!line) return null;

  const lines = model.lines.map((l) =>
    l.line_id !== lineId
      ? l
      : {
          ...l,
          cuts: l.cuts.map((c) => {
            if (c.uid !== cutUid) return c;
            if (handle === "start") {
              return { ...c, start_x: Math.max(clampX(l, x), c.end_x + MIN_BOX_WIDTH) };
            }
            if (handle === "end") {
              return { ...c, end_x: Math.min(clampX(l, x), c.start_x - MIN_BOX_WIDTH) };
            }
            const from = grab ?? { start_x: c.start_x, end_x: c.end_x, at: c.start_x };
            const width = from.start_x - from.end_x;
            const start = clampX(l, from.start_x + (x - from.at));
            const end = start - width;
            return end < l.bbox.x
              ? { ...c, start_x: l.bbox.x + width, end_x: l.bbox.x }
              : { ...c, start_x: start, end_x: end };
          }),
        },
  );
  return { ...model, lines };
}

/** Mark a box as carrying a word the stored text has no row for, or take that back.
 * The stretch renumbers because the box has just left (or rejoined) the sequence the
 * ids are handed out along. */
/** Can this word move to the line above (`-1`) or below (`+1`)?
 *
 * Only the word at that end of the line: the page's words are one sequence, and
 * lifting one out of the middle would break it.
 */
export function canMoveLine(
  model: WordsModel,
  lineId: string,
  cutUid: string,
  step: -1 | 1,
): boolean {
  const index = model.lines.findIndex((l) => l.line_id === lineId);
  if (index < 0) return false;
  const at = model.lines[index].cuts.findIndex((c) => c.uid === cutUid);
  if (at < 0) return false;
  const boundary = step === -1 ? at === 0 : at === model.lines[index].cuts.length - 1;
  return boundary && neighbour(model.lines, index, step) >= 0;
}

/** The next text line above or below, by index, or -1. Sura headers and besmella
 * lines hold no words and are stepped over. */
function neighbour(lines: EditLine[], index: number, step: -1 | 1): number {
  for (let i = index + step; i >= 0 && i < lines.length; i += step) {
    if (holdsWords(lines[i])) return i;
  }
  return -1;
}

/**
 * Move the word at the end of a line onto the neighbouring line.
 *
 * The fix for a line break in the wrong place: the mushaf prints a word at the end
 * of one line and the engine assigned it to the next. Adding and removing cuts can
 * express that *within* an aya — the labels shift along — but not across an ornament,
 * because the renumber stops there by design, and the aya boundary is exactly where
 * a misplaced line break tends to sit.
 *
 * So this moves the **slot**, not the label. The page's sequence is untouched; only
 * which line holds the word changes, and its label travels with it. The box is
 * dropped into the free space at the end of the line it arrives on — which is where
 * its ink is, if the line break really was the problem — and dragged from there.
 */
export function moveWordToLine(
  model: WordsModel,
  lineId: string,
  cutUid: string,
  step: -1 | 1,
): WordsModel | null {
  if (!canMoveLine(model, lineId, cutUid, step)) return null;
  const from = model.lines.findIndex((l) => l.line_id === lineId);
  const to = neighbour(model.lines, from, step);
  const cut = model.lines[from].cuts.find((c) => c.uid === cutUid)!;
  const target = model.lines[to];
  const width = cut.start_x - cut.end_x;

  // Up: it lands at the far LEFT of the line above, after that line's last word.
  // Down: at the far RIGHT of the line below, before its first. Both are the free
  // end of the target line, which is where a word pushed off a line break belongs.
  const placed =
    step === -1
      ? {
          start_x: target.cuts.length
            ? target.cuts[target.cuts.length - 1].end_x
            : target.bbox.x + target.bbox.w,
          end_x: target.bbox.x,
        }
      : {
          start_x: target.bbox.x + target.bbox.w,
          end_x: target.cuts.length ? target.cuts[0].start_x : target.bbox.x,
        };
  // Keep the word's own width when the free space is wider than it needs.
  const span =
    placed.start_x - placed.end_x > width
      ? step === -1
        ? { start_x: placed.start_x, end_x: placed.start_x - width }
        : { start_x: placed.end_x + width, end_x: placed.end_x }
      : placed;

  const moved: EditCut = { ...cut, ...span };
  const lines = model.lines.map((l, i) => {
    if (i === from) return { ...l, cuts: l.cuts.filter((c) => c.uid !== cutUid) };
    if (i === to) {
      return step === -1 ? { ...l, cuts: [...l.cuts, moved] } : { ...l, cuts: [moved, ...l.cuts] };
    }
    return l;
  });
  return withRenumber({ ...model, lines });
}

export function toggleUnlabelled(model: WordsModel, lineId: string, cutUid: string): WordsModel {
  const lines = model.lines.map((l) =>
    l.line_id === lineId
      ? {
          ...l,
          cuts: l.cuts.map((c) => (c.uid === cutUid ? { ...c, unlabelled: !c.unlabelled } : c)),
        }
      : l,
  );
  return withRenumber({ ...model, lines });
}

function withRenumber(model: WordsModel): WordsModel {
  return { ...model, lines: renumber(model) };
}

// ── Saving ───────────────────────────────────────────────────────────────────

/** What a line looks like right now, for comparison against its saved state.
 * Position-sensitive by construction: reordering the cuts changes the string even
 * when every id and x is unchanged, which is exactly an edit worth saving. */
export function lineSignature(line: EditLine): string {
  return line.cuts.map((c) => `${c.word_id ?? ""}@${c.start_x}..${c.end_x}`).join("|");
}

export function baselineOf(lines: EditLine[]): Map<string, string> {
  return new Map(lines.map((l) => [l.line_id, lineSignature(l)] as const));
}

export function dirtyLines(lines: EditLine[], baseline: Map<string, string>): EditLine[] {
  return lines.filter((l) => baseline.get(l.line_id) !== lineSignature(l));
}

/** The PUT body: whole lines, only the ones that changed. Whole lines because the
 * errors that matter move a word between two of them, and both have to change in
 * one transaction or the word is briefly on both or on neither.
 *
 * The array order carries the reading order — the server stores it as `position` and
 * sends nothing back to contradict it. */
export function savePayload(lines: EditLine[]) {
  return {
    lines: lines.map((l) => ({
      line_id: l.line_id,
      words: l.cuts.map((c) => ({
        word_id: c.unlabelled ? null : c.word_id,
        start_x: c.start_x,
        end_x: c.end_x,
      })),
    })),
  };
}

// ── Triage ───────────────────────────────────────────────────────────────────

/** Lines the engine was not confident about. The whole point of storing a verdict:
 * a sura-7 run comes back with 136 of 388 lines worth a look, so a reviewer reads
 * 136 lines instead of eyeballing 3,320 words. */
export function needsReview(line: EditLine): boolean {
  return holdsWords(line) && line.status != null && line.status !== "exact";
}

export function flaggedLines(lines: EditLine[]): EditLine[] {
  return lines.filter(needsReview);
}

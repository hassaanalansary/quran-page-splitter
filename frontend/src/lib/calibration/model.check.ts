// Checks for the calibration model. There is no frontend test runner in this
// repo; the model has only type-only imports, so Node runs it as it stands:
//
//     node src/lib/calibration/model.check.ts
//
// (Node 22 needs --experimental-strip-types; 23.6 and later strip types by default.)
// Silent on success, a stack trace on the first failure.
import assert from "node:assert/strict";

import { decidedOfBlob, readBlobFromServer } from "./contents.ts";
import {
  NO_SELECTION,
  applyContentsChip,
  layWordPieces,
  nextPieceRun,
  spreadPieces,
  acceptExpected,
  doubtsOf,
  expectationsOf,
  expectedType,
  extendSelection,
  highlights,
  isTyped,
  passesFilter,
  answeredBy,
  typedByText,
  addSubtypePart,
  composeSubtype,
  togglePart,
  markChecksOf,
  markCheckOf,
  tanweenOf,
  stepBlob,
  stepLine,
  stepWord,
  wordAt,
  changedWords,
  galleryGroups,
  stepGallery,
  teaches,
  wordRisks,
  typeCounts,
  typeFilter,
  typeTally,
  typingSignature,
  assignToWord,
  attentionItems,
  activeAttention,
  currentOf,
  decodeLabels,
  draftOf,
  editSignature,
  historyOf,
  inkOf,
  labelAt,
  labelsInRect,
  newRequestId,
  pageExceptions,
  pushHistory,
  releaseDecisions,
  giveBackToStructure,
  requestIds,
  selectIds,
  setErased,
  setException,
  toggleFusedMark,
  setRole,
  setSubtype,
  noiseFor,
  noiseOf,
  needsLook,
  unassignMarks,
  shareBetween,
  clearCut,
  cutBlob,
  swapCutPiece,
  stepAttention,
  stepHistory,
  wordCount,
} from "./model.ts";
import type { CalibrationBlob, CalibrationLine, CalibrationWord } from "./types.ts";

// One line, three words right to left, one body each, and a dot over the first.
function blob(id: number, x: number, role: "body" | "mark", word: number | null): CalibrationBlob {
  return {
    id,
    x,
    y: 10,
    w: 30,
    h: 20,
    area: 600,
    body_score: role === "body" ? 13 : 2,
    role,
    initial_role: role,
    explicit: false,
    ownership_explicit: false,
    subtype: "",
    exception: "",
    allocations: word === null ? [] : [{ word_id: word, paws: role === "body" ? 1 : 0 }],
    attention: [],
    decision_source: "search",
    proposed_role: null,
    proposal: {},
  };
}

function word(id: number, right: number, left: number): CalibrationWord {
  return {
    word_id: id,
    text: `w${id}`,
    aya: "2:5",
    expected_paws: 1,
    start_x: right,
    end_x: left,
    shared: false,
  };
}

function line(snapshot = "s1", readonly = false): CalibrationLine {
  return {
    snapshot_id: snapshot,
    line_id: `l-${snapshot}`,
    page_number: 1,
    line_number: 1,
    bbox: { x: 100, y: 0, w: 600, h: 40 },
    band: [8, 32],
    readonly,
    approved: false,
    status: "exact",
    reason: null,
    blobs: [
      blob(1, 580, "body", 1),
      blob(2, 590, "mark", 1),
      blob(3, 460, "body", 2),
      blob(4, 340, "body", 3),
    ],
    words: [word(1, 610, 580), word(2, 490, 460), word(3, 370, 340)],
  };
}

const pick = (lines: CalibrationLine[], id: number) => lines[0].blobs.find((b) => b.id === id)!;
const sel = (ids: number[], snapshot = "s1") => ({ snapshot, ids });

// Bulk typing/unassignment targets marks only, while word assignment targets both.
{
  const initial = line();
  initial.blobs.push(blob(6, 350, "mark", 3));
  initial.blobs[1].attention = ["uncertain", "calibration-disagreement"];
  const typed = setSubtype([initial], sel([1, 2, 6]), "fatha");
  assert.equal(pick(typed, 1).subtype, "");
  for (const id of [2, 6]) {
    assert.equal(pick(typed, id).subtype, "fatha");
    assert.equal(pick(typed, id).explicit, true);
    assert.equal(pick(typed, id).subtype_explicit, true);
  }
  assert.deepEqual(activeAttention(pick(typed, 2)), []);
  const detached = unassignMarks(typed, sel([1, 2, 6]));
  assert.deepEqual(pick(detached, 1).allocations, pick(typed, 1).allocations);
  assert.deepEqual(pick(detached, 2).allocations, []);
  assert.equal(pick(detached, 2).ownership_explicit, true);
  assert.deepEqual(detached[0].words, typed[0].words);
  const history = pushHistory(historyOf(typed), detached);
  assert.equal(currentOf(stepHistory(history, -1)), typed);
  pick(typed, 2).attention.push("constraint-conflict");
  assert.deepEqual(activeAttention(pick(typed, 2)), ["constraint-conflict"]);
}

// A body turned into a mark gives back its PAW but stays attached; its word loses it.
{
  const lines = setRole([line()], sel([3]), "mark");
  assert.equal(pick(lines, 3).role, "mark");
  assert.equal(pick(lines, 3).explicit, true);
  assert.deepEqual(pick(lines, 3).allocations, [{ word_id: 2, paws: 0 }]);
  assert.deepEqual(wordCount(lines[0], lines[0].words[1]), { got: 0, want: 1, ok: false });
  // No body left: the word keeps its edges rather than inventing new ones.
  assert.equal(lines[0].words[1].end_x, 460);
}

// Structure keeps its role whatever the palette says.
{
  const withRing = line();
  withRing.blobs.push({
    ...blob(5, 200, "body", null),
    role: "ornament",
    initial_role: "ornament",
  });
  const lines = setRole([withRing], sel([5]), "body");
  assert.equal(pick(lines, 5).role, "ornament");
}

// A blob matched as a sajda or rub' sign may be called text, and taken back.
{
  const withSign = line();
  withSign.blobs.push({
    ...blob(5, 200, "mark", null),
    role: "symbol",
    initial_role: "symbol",
  });
  // Picked only when the filter shows everything; never with a kind of mark chosen.
  const sign = pick([withSign], 5);
  assert.equal(passesFilter(sign, "s1", "all", new Map(), new Map()), true);
  assert.equal(passesFilter(sign, "s1", "mark", new Map(), new Map()), false);
  // A sign is not erased, nor given to a word, until it is text.
  assert.equal(pick(setErased([withSign], sel([5]), true), 5).erased, undefined);
  assert.deepEqual(pick(assignToWord([withSign], sel([5]), 3), 5).allocations, []);

  const text = setRole([withSign], sel([5]), "body");
  assert.deepEqual(
    [pick(text, 5).role, pick(text, 5).explicit, pick(text, 5).allocations],
    ["body", true, []],
  );
  const owned = assignToWord(text, sel([5]), 3);
  assert.deepEqual(pick(owned, 5).allocations, [{ word_id: 3, paws: 1 }]);
  assert.equal(owned[0].words[2].end_x, 200, "its word takes the ink in");

  // Made a symbol again, by hand or by releasing the decision: out of its word.
  for (const again of [giveBackToStructure(owned, sel([5])), releaseDecisions(owned, sel([5]))]) {
    assert.deepEqual(
      [pick(again, 5).role, pick(again, 5).explicit, pick(again, 5).allocations],
      ["symbol", false, []],
    );
    assert.equal(again[0].words[2].end_x, 340, "its word lets the ink go");
  }
  // Text that was always text is no structure to go back to.
  assert.equal(pick(giveBackToStructure([line()], sel([3])), 3).role, "body");
}

// A piece grouped with an aya ornament may be called text too; its ring never.
{
  const withOrnament = line();
  withOrnament.blobs.push(
    { ...blob(6, 150, "body", null), role: "ornament", initial_role: "ornament", ring: true },
    { ...blob(7, 160, "mark", null), role: "ornament", initial_role: "ornament", ring: false },
    // A draft made before rings were marked: no piece may be told apart from its ring.
    { ...blob(8, 100, "mark", null), role: "ornament", initial_role: "ornament" },
  );
  const lines = [withOrnament];
  assert.deepEqual(
    [6, 7, 8].map((id) => passesFilter(pick(lines, id), "s1", "all", new Map(), new Map())),
    [false, true, false],
  );
  const text = setRole(lines, sel([6, 7, 8]), "mark");
  assert.deepEqual(
    [6, 7, 8].map((id) => pick(text, id).role),
    ["ornament", "mark", "ornament"],
  );
  assert.equal(pick(text, 7).explicit, true);
  const back = giveBackToStructure(text, sel([7]));
  assert.deepEqual([pick(back, 7).role, pick(back, 7).explicit], ["ornament", false]);
  assert.equal(pick(releaseDecisions(text, sel([7])), 7).role, "ornament");
}

// Assigning a body moves the count and both words' edges.
{
  const lines = assignToWord([line()], sel([3]), 1);
  assert.deepEqual(pick(lines, 3).allocations, [{ word_id: 1, paws: 1 }]);
  assert.equal(pick(lines, 3).ownership_explicit, true);
  assert.equal(pick(lines, 3).explicit, false, "ownership does not decide the role");
  const [first, second] = lines[0].words;
  assert.deepEqual([first.start_x, first.end_x], [620, 460]);
  assert.deepEqual(wordCount(lines[0], second), { got: 0, want: 1, ok: false });
}

// Assigned marks expand the recipient and their removal shrinks the previous owner.
{
  const lines = assignToWord([line()], sel([2]), 3);
  assert.deepEqual(pick(lines, 2).allocations, [{ word_id: 3, paws: 0 }]);
  assert.deepEqual([lines[0].words[2].start_x, lines[0].words[2].end_x], [620, 340]);
  assert.equal(lines[0].words[0].start_x, 610);
  const detached = unassignMarks(lines, sel([2]));
  assert.equal(detached[0].words[2].start_x, 370);
}

// Words 2 and 3 printed touching, as one blob: shared, each ends or starts at its
// middle, and each count closes on its own share.
{
  const fused = line();
  fused.blobs = [
    blob(1, 580, "body", 1),
    blob(2, 590, "mark", 1),
    { ...blob(3, 340, "body", 2), w: 150 },
  ];
  const lines = shareBetween([fused], sel([3]), [
    { word_id: 2, paws: 1 },
    { word_id: 3, paws: 1 },
  ]);
  const [, second, third] = lines[0].words;
  assert.deepEqual([second.start_x, second.end_x, second.shared], [490, 415, true]);
  assert.deepEqual([third.start_x, third.end_x, third.shared], [415, 340, true]);
  assert.equal(wordCount(lines[0], second).ok, true);
  assert.equal(wordCount(lines[0], third).ok, true);
  // A share on top of a word's own full count is a count that does not close.
  const extra = shareBetween([line()], sel([3]), [
    { word_id: 2, paws: 1 },
    { word_id: 3, paws: 1 },
  ]);
  assert.deepEqual(wordCount(extra[0], extra[0].words[2]), { got: 2, want: 1, ok: false });
  const input = [line()];
  const two = [
    { word_id: 2, paws: 1 },
    { word_id: 3, paws: 1 },
  ];
  assert.equal(shareBetween(input, sel([3, 4]), two), input, "one blob at a time");
  assert.equal(
    shareBetween(input, sel([3]), [{ word_id: 2, paws: 1 }]),
    input,
    "at least two words",
  );

  // The knife: cut at x 470, word 2 keeps its piece 470-489 and word 3 the rest.
  const knife = {
    lines: [[470, 2, 470, 38]] as [number, number, number, number][],
    owners: [2, 3],
    pieces: [
      { x: 470, y: 10, w: 20, h: 20, area: 400 },
      { x: 340, y: 10, w: 130, h: 20, area: 2600 },
    ],
  };
  const cut = cutBlob(lines, "s1", 3, knife);
  const [, cutSecond, cutThird] = cut[0].words;
  assert.deepEqual([cutSecond.start_x, cutSecond.end_x], [490, 470]);
  assert.deepEqual([cutThird.start_x, cutThird.end_x], [470, 340]);
  // Sent without its pieces: the server measures them again.
  assert.deepEqual(draftOf({ revision: 3 }, cut, "r").lines[0].blobs[2].cut, {
    lines: knife.lines,
    owners: [2, 3],
  });
  assert.equal(draftOf({ revision: 3 }, lines, "r").lines[0].blobs[2].cut, null);
  // A click on a piece gives it the other word.
  const swapped = swapCutPiece(cut, "s1", 3, 0);
  assert.deepEqual(pick(swapped, 3).cut?.owners, [3, 2]);
  assert.deepEqual([swapped[0].words[2].start_x, swapped[0].words[2].end_x], [490, 470]);
  // Not a cut of this blob's words, or not one piece per word: refused, unchanged.
  assert.deepEqual(cutBlob(lines, "s1", 3, { ...knife, owners: [2, 4] }), lines);
  assert.deepEqual(cutBlob(lines, "s1", 3, { ...knife, pieces: knife.pieces.slice(1) }), lines);
  // Cleared, the middle again.
  const cleared = clearCut(cut, sel([3]));
  assert.equal(pick(cleared, 3).cut, undefined);
  assert.deepEqual([cleared[0].words[1].end_x, cleared[0].words[2].start_x], [415, 415]);
  // Unshared, turned into a mark or erased, the blob loses its cut.
  assert.equal(pick(assignToWord(cut, sel([3]), 2, 2), 3).cut, undefined);
  assert.equal(pick(setRole(cut, sel([3]), "mark"), 3).cut, undefined);
  assert.equal(pick(setErased(cut, sel([3]), true), 3).cut, undefined);
  // The same words sharing it with other PAW counts keep it.
  const recounted = shareBetween(cut, sel([3]), [
    { word_id: 2, paws: 1 },
    { word_id: 3, paws: 2 },
  ]);
  assert.deepEqual(pick(recounted, 3).cut?.owners, [2, 3]);
}

// Read-only context is never edited, nor sent.
{
  const lines = [line(), line("ctx", true)];
  const edited = setRole(lines, sel([1], "ctx"), "mark");
  assert.equal(edited[1], lines[1]);
  const draft = draftOf({ revision: 3 }, lines, "r");
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.revision, 3);
  assert.equal(draft.lines[0].blobs[0].ownership_explicit, false);
  // Blob decisions only: every box is the server's to take from the ink.
  assert.ok(!("words" in draft.lines[0]));
}

// Any edit changes the signature; releasing a decision takes it back off.
{
  const base = [line()];
  const flagged = setException(base, sel([1]), "broken");
  assert.notEqual(editSignature(flagged), editSignature(base));
  const decided = setRole(base, sel([1]), "body");
  assert.notEqual(editSignature(decided), editSignature(base));
  assert.equal(editSignature(releaseDecisions(decided, sel([1]))), editSignature(base));
}

// An erased blob is no ink of the text: it leaves its word, which shrinks to the ink
// it has left, loses its type and flag, asks for nothing — and is sent as erased.
// Restored, it is ink again, unowned until the next preview reads it.
{
  const initial = line();
  initial.blobs[1] = {
    ...initial.blobs[1],
    subtype: "ijamDot",
    subtype_explicit: true,
    exception: "uncertain",
    attention: ["ambiguous"],
    x: 560,
  };
  initial.words[0] = { ...initial.words[0], end_x: 560 };
  const erased = setErased([initial], sel([2]), true);
  const dot = pick(erased, 2);
  assert.deepEqual(
    [dot.erased, dot.role, dot.allocations, dot.subtype, dot.exception, needsLook(dot)],
    [true, "mark", [], "", "", false],
  );
  assert.equal(erased[0].words[0].end_x, 580, "the word takes its box from its own ink");
  assert.equal(pageExceptions(erased).length, 0);
  assert.equal(teaches(erased).marks, 0);
  assert.equal(isTyped(dot), false);
  assert.equal(draftOf({ revision: 1 }, erased, "r").lines[0].blobs[1].erased, true);
  assert.equal(draftOf({ revision: 1 }, [initial], "r").lines[0].blobs[1].erased, false);
  assert.notEqual(typingSignature(erased), typingSignature([initial]));
  // Picked by role, to be restored — never as a kind of mark.
  assert.equal(passesFilter(dot, "s1", "mark", new Map(), new Map()), true);
  assert.equal(passesFilter(dot, "s1", "untyped", new Map(), new Map()), false);
  // Nothing types, assigns or flags erased ink.
  assert.equal(pick(setSubtype(erased, sel([2]), "fatha"), 2).subtype, "");
  assert.deepEqual(pick(assignToWord(erased, sel([2]), 1), 2).allocations, []);
  assert.equal(pick(setException(erased, sel([2]), "broken"), 2).exception, "");
  const restored = setErased(erased, sel([2]), false);
  assert.deepEqual([pick(restored, 2).erased, pick(restored, 2).allocations], [false, []]);
  // Structure is never erased.
  const withRing = line();
  withRing.blobs.push({
    ...blob(5, 200, "body", null),
    role: "ornament",
    initial_role: "ornament",
  });
  assert.equal(pick(setErased([withRing], sel([5]), true), 5).erased, undefined);
}

// A noise suspicion holds only while the blob is still ink.
{
  const noise = noiseOf([
    { snapshot_id: "s1", blob_id: 2, kind: "speck", edge: true, distance: null },
  ]);
  assert.equal(noiseFor(pick([line()], 2), "s1", noise)?.kind, "speck");
  assert.equal(noiseFor(pick(setErased([line()], sel([2]), true), 2), "s1", noise), null);
  assert.equal(noiseFor(pick([line()], 1), "s1", noise), null);
}

// Attention runs right to left over editable lines and wraps.
{
  const lines = [line()];
  lines[0].blobs[3].attention = ["uncertain"];
  lines[0].blobs[0].attention = ["search-override"];
  const items = attentionItems(lines);
  assert.deepEqual(
    items.map((item) => item.ids[0]),
    [1, 4],
  );
  assert.deepEqual(stepAttention(lines, NO_SELECTION, 1), { snapshot: "s1", ids: [1] });
  assert.deepEqual(stepAttention(lines, sel([4]), 1), { snapshot: "s1", ids: [1] });
  assert.deepEqual(stepAttention(lines, sel([1]), -1), { snapshot: "s1", ids: [4] });
}

// Exceptions: a flag, a count that does not close, an unsettled line; never context.
{
  const lines = setException(
    setRole([line(), line("ctx", true)], sel([3]), "mark"),
    sel([1]),
    "broken",
  );
  lines[0] = { ...lines[0], status: "partial", reason: "constraint-conflict" };
  assert.deepEqual(
    pageExceptions(lines).map((item) => item.kind),
    ["flagged", "paw-count", "unresolved"],
  );
  assert.deepEqual(pageExceptions([line()]), []);
}

// Selection: replace, add, toggle.
assert.deepEqual(selectIds([1, 2], [3], false), [3]);
assert.deepEqual(selectIds([1, 2], [3], true), [1, 2, 3]);
assert.deepEqual(selectIds([1, 2], [2], true, true), [1]);

// History: one entry per state, capped, stepping clamps.
{
  let history = historyOf(0);
  history = pushHistory(history, 1);
  history = pushHistory(history, 2);
  history = stepHistory(history, -1);
  assert.equal(history.stack[history.index], 1);
  history = pushHistory(history, 9);
  assert.deepEqual(history.stack, [0, 1, 9]);
  assert.equal(stepHistory(stepHistory(history, 1), 1).index, 2);
}

// The raster: exact ids at native size, background zero, rectangles by pixels.
{
  // 3x2 image: ids 1, 258 (G=1, R=2), 0 / 65536 (B=1), 1, 0; one transparent pixel.
  const rgba = [1, 0, 0, 255, 2, 1, 0, 255, 0, 0, 0, 255, 0, 0, 1, 255, 1, 0, 0, 255, 9, 9, 9, 0];
  const ids = decodeLabels(rgba);
  assert.deepEqual([...ids], [1, 258, 0, 65536, 1, 0]);
  assert.equal(labelAt(ids, 3, 2, 1.7, 0.2), 258);
  assert.equal(labelAt(ids, 3, 2, 5, 0), 0);
  assert.deepEqual(
    labelsInRect(ids, 3, 2, 0, 0, 2, 2).sort((a, b) => a - b),
    [1, 258, 65536],
  );
}

// A word's ink: its bodies and the marks attached to it.
assert.deepEqual(inkOf(line(), 1), [1, 2]);
assert.deepEqual(inkOf(line(), null), []);

// Request ids: one per exact request, kept until the server answers it.
{
  assert.match(
    newRequestId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const ids = requestIds();
  const first = ids.for("save:3:abc");
  assert.equal(ids.for("save:3:abc"), first, "a retry reuses the id");
  assert.notEqual(ids.for("save:3:abd"), first, "different edits, a different request");
  const second = ids.for("save:3:abc");
  assert.notEqual(second, first, "only the latest request is held");
  ids.answered("save:3:abc");
  assert.notEqual(ids.for("save:3:abc"), second, "answered: the next send is a new request");
}

// A mark made a body counts as one PAW; a body said to be broken keeps its zero.
{
  const lines = setRole([line()], sel([2]), "body");
  assert.deepEqual(pick(lines, 2).allocations, [{ word_id: 1, paws: 1 }]);
  const broken = setRole(assignToWord([line()], sel([3]), 2, 0), sel([3]), "body");
  assert.deepEqual(pick(broken, 3).allocations, [{ word_id: 2, paws: 0 }]);
}

// A mixed selection gives PAWs only to bodies.
{
  const lines = assignToWord([line()], sel([1, 2]), 3, 1);
  assert.deepEqual(pick(lines, 1).allocations, [{ word_id: 3, paws: 1 }]);
  assert.deepEqual(pick(lines, 2).allocations, [{ word_id: 3, paws: 0 }]);
}

// Ordinary ink given to a word that shares a body: the box reaches the new ink, and
// still ends at the shared body's middle.
{
  let lines = shareBetween([line()], sel([3]), [
    { word_id: 2, paws: 1 },
    { word_id: 3, paws: 1 },
  ]);
  lines = assignToWord(lines, sel([1]), 2);
  assert.deepEqual([lines[0].words[1].start_x, lines[0].words[1].end_x], [610, 475]);
}

// Accepting a persisted preview adds a history step instead of resetting history.
{
  const before = setRole([line()], sel([1]), "body");
  const accepted = [line()];
  const history = pushHistory(pushHistory(historyOf([line()]), before), accepted);
  assert.equal(currentOf(stepHistory(history, -1)), before);
  assert.equal(currentOf(stepHistory(stepHistory(history, -1), 1)), accepted);
}

// Expected types: a guess for untyped marks only; accepting one is typing it.
{
  const page = line();
  page.blobs.push({ ...blob(6, 350, "mark", 3), subtype: "kasra", subtype_explicit: true });
  const expectations = expectationsOf([
    { snapshot_id: "s1", blob_id: 2, subtype: "fatha", confidence: 0.95, sure: true },
    { snapshot_id: "s1", blob_id: 6, subtype: "damma", confidence: 0.9, sure: true },
  ]);
  // A typed mark expects nothing, whatever the server guessed; a body neither.
  assert.equal(expectedType(pick([page], 6), "s1", expectations), null);
  assert.equal(expectedType(pick([page], 1), "s1", expectations), null);
  assert.equal(expectedType(pick([page], 2), "s1", expectations)?.subtype, "fatha");
  assert.deepEqual(typeCounts([page], expectations), { marks: 2, typed: 1, expected: 1, sure: 1 });

  const accepted = acceptExpected([page], expectations, "sure");
  assert.deepEqual(
    [pick(accepted, 2).subtype, pick(accepted, 2).subtype_explicit, pick(accepted, 2).explicit],
    ["fatha", true, true],
  );
  assert.equal(pick(accepted, 6).subtype, "kasra", "a person's own type is never replaced");
  assert.ok(isTyped(pick(accepted, 2)));
  assert.notEqual(typingSignature(accepted), typingSignature([page]));

  // An unsure guess waits for a person — unless they accept it on the selection.
  const unsure = expectationsOf([
    { snapshot_id: "s1", blob_id: 2, subtype: "fatha", confidence: 0.5, sure: false },
  ]);
  assert.equal(acceptExpected([page], unsure, "sure")[0], page);
  assert.equal(pick(acceptExpected([page], unsure, sel([2])), 2).subtype, "fatha");

  // A stored guess that was never accepted still reads as expected, not typed.
  const stale = { ...blob(7, 300, "mark", 3), subtype: "sukun", subtype_explicit: false };
  assert.equal(isTyped(stale), false);
  assert.deepEqual(expectedType(stale, "s1", new Map()), {
    subtype: "sukun",
    sure: false,
    confidence: 0,
  });
}

// A box holds all of its word's ink, its marks too, once anything recalculates it.
{
  // The fixture's first word is drawn as the engine once cut it: its mark sticks out.
  const page = line();
  assert.deepEqual([page.words[0].start_x, page.words[0].end_x], [610, 580]);
  const held = assignToWord([page], sel([2]), 1)[0].words[0];
  assert.deepEqual([held.start_x, held.end_x], [620, 580]);
}

// Filters: a type is the typed type, else the expected one; doubts only while the
// mark is still typed as doubted.
{
  const page = line();
  page.blobs.push({ ...blob(6, 350, "mark", 3), subtype: "shadda", subtype_explicit: true });
  const expectations = expectationsOf([
    { snapshot_id: "s1", blob_id: 2, subtype: "fatha", confidence: 0.9, sure: true },
  ]);
  const doubts = doubtsOf([
    { snapshot_id: "s1", blob_id: 6, typed: "shadda", subtype: "wasla", sure: true },
  ]);
  const passing = (filter: Parameters<typeof passesFilter>[2]) =>
    page.blobs.filter((b) => passesFilter(b, "s1", filter, expectations, doubts)).map((b) => b.id);
  assert.deepEqual(passing("all"), [1, 2, 3, 4, 6]);
  assert.deepEqual(passing("body"), [1, 3, 4]);
  assert.deepEqual(passing(typeFilter("fatha")), [2]);
  assert.deepEqual(passing(typeFilter("shadda")), [6]);
  assert.deepEqual(passing("untyped"), [2]);
  assert.deepEqual(passing("doubtful"), [6]);
  assert.equal(highlights("mark"), false);
  assert.equal(highlights("doubtful"), true);
  const retyped = setSubtype([page], sel([6]), "wasla")[0];
  assert.equal(passesFilter(retyped.blobs[4], "s1", "doubtful", expectations, doubts), false);
  const tally = typeTally([page], expectations, doubts);
  assert.deepEqual(tally.types.get("fatha"), { typed: 0, expected: 1 });
  assert.deepEqual(tally.types.get("shadda"), { typed: 1, expected: 0 });
  assert.deepEqual([tally.untyped, tally.doubtful], [1, 1]);
}

// Moving: reading order right to left, line after line, wrapping; filtered; a line
// up or down lands nearest across; Shift adds within the line.
{
  const second = { ...line("s2"), line_number: 2 };
  const lines = [line(), second, line("ctx", true)];
  const any = () => true;
  const marks = (_: unknown, b: { role: string }) => b.role === "mark";
  // Mark 2 ends furthest right (620), then body 1 (610), bodies 3 and 4.
  assert.deepEqual(stepBlob(lines, NO_SELECTION, 1, any), sel([2]));
  assert.deepEqual(stepBlob(lines, sel([2]), 1, any), sel([1]));
  assert.deepEqual(stepBlob(lines, sel([4]), 1, any), sel([2], "s2"));
  assert.deepEqual(stepBlob(lines, sel([4], "s2"), 1, any), sel([2]), "wraps, skipping context");
  assert.deepEqual(stepBlob(lines, sel([2]), -1, any), sel([4], "s2"));
  assert.deepEqual(stepBlob(lines, sel([1]), 1, marks), sel([2], "s2"));
  assert.equal(
    stepBlob(lines, NO_SELECTION, 1, () => false),
    null,
  );
  assert.deepEqual(stepLine(lines, sel([3]), 1, any), sel([3], "s2"));
  assert.equal(stepLine(lines, sel([3], "s2"), 1, any), null, "context is not a line to land on");
  assert.deepEqual(stepLine(lines, sel([3], "s2"), -1, marks), sel([2]));
  assert.deepEqual(extendSelection(lines, sel([1]), 1, any), sel([1, 3]));
  assert.deepEqual(extendSelection(lines, sel([4]), 1, any), sel([4]), "not past the line's end");
  assert.deepEqual(extendSelection(lines, sel([3]), -1, any), sel([3, 1]));
}

// Words: all of a word's ink at once, in reading order across lines, wrapping; the
// word the selection is in is its first blob's owner.
{
  const second = { ...line("s2"), line_number: 2 };
  const lines = [line(), second];
  assert.deepEqual(stepWord(lines, NO_SELECTION, 1), sel([1, 2]));
  assert.equal(wordAt(lines, sel([2])), 0);
  assert.deepEqual(stepWord(lines, sel([2]), 1), sel([3]));
  assert.deepEqual(stepWord(lines, sel([4]), 1), sel([1, 2], "s2"));
  assert.deepEqual(stepWord(lines, sel([1], "s2"), -1), sel([4]));
  assert.deepEqual(stepWord(lines, NO_SELECTION, -1), sel([4], "s2"));
}

// Accepting what a filter shows: every expected mark the test lets through, page-wide.
{
  const page = line();
  page.blobs.push(blob(6, 350, "mark", 3));
  const expectations = expectationsOf([
    { snapshot_id: "s1", blob_id: 2, subtype: "fatha", confidence: 0.5, sure: false },
    { snapshot_id: "s1", blob_id: 6, subtype: "kasra", confidence: 0.9, sure: true },
  ]);
  const fathas = acceptExpected([page], expectations, (l, b) =>
    passesFilter(b, l.snapshot_id, typeFilter("fatha"), expectations, new Map()),
  );
  assert.deepEqual([pick(fathas, 2).subtype, pick(fathas, 2).subtype_explicit], ["fatha", true]);
  assert.equal(pick(fathas, 6).subtype, "", "a kasra is not shown by the fatha filter");
}

// Words: stepping through a test finds the next word that passes it, from anywhere.
{
  const second = { ...line("s2"), line_number: 2 };
  const lines = [line(), second];
  const third = (_: unknown, w: { word_id: number | null }) => w.word_id === 3;
  assert.deepEqual(stepWord(lines, sel([2]), 1, third), sel([4]));
  assert.deepEqual(stepWord(lines, sel([4]), 1, third), sel([4], "s2"));
  assert.equal(
    stepWord(lines, NO_SELECTION, 1, () => false),
    null,
  );
}

// Risky words: a count that does not close, ink asking for a look.
{
  const page = line();
  assert.deepEqual(wordRisks(page, page.words[0]), []);
  const marked = setRole([page], sel([3]), "mark")[0];
  assert.deepEqual(wordRisks(marked, marked.words[1]), ["count"]);
  const looked = line();
  looked.blobs[0].attention = ["uncertain"];
  assert.deepEqual(wordRisks(looked, looked.words[0]), ["look"]);
}

// A preview's moved words: an edge beyond a pixel, a line change, a word dropped.
{
  const before = [line()];
  const after = [{ ...line(), words: [word(1, 610, 580), word(2, 492, 460)] }];
  assert.deepEqual([...changedWords(before, after)].sort(), [2, 3]);
  assert.equal(changedWords(before, [line()]).size, 0);
}

// What a confirmation teaches: roles of every text blob but flagged ones and bodies of
// other than one PAW; types of typed marks only.
{
  const page = line();
  page.blobs.push({ ...blob(6, 350, "mark", 3), subtype: "kasra", subtype_explicit: true });
  page.blobs.push({ ...blob(7, 300, "mark", 3), exception: "broken" });
  assert.deepEqual(teaches([page, line("ctx", true)]), { bodies: 3, marks: 2, typed: 1 });
  const two = assignToWord([page], sel([1]), 1, 2);
  assert.equal(teaches(two).bodies, 2);
}

// The gallery: marks by their type, doubts and unsure guesses first, untyped last;
// or all ink by role; stepping wraps, and ↑↓ jump between groups.
{
  const page = line();
  page.blobs.push({ ...blob(6, 350, "mark", 3), subtype: "fatha", subtype_explicit: true });
  page.blobs.push({ ...blob(7, 300, "mark", 3), subtype: "fatha", subtype_explicit: true });
  page.blobs.push(blob(8, 250, "mark", null));
  const expectations = expectationsOf([
    { snapshot_id: "s1", blob_id: 2, subtype: "fatha", confidence: 0.3, sure: false },
  ]);
  const doubts = doubtsOf([
    { snapshot_id: "s1", blob_id: 7, typed: "fatha", subtype: "madda", sure: true },
  ]);
  const types = galleryGroups([page], "types", "all", expectations, doubts);
  assert.deepEqual(
    types.map((g) => [g.key, g.items.map((i) => i.blob.id), g.typed, g.expected]),
    [
      ["fatha", [7, 2, 6], 2, 1],
      ["", [8], 0, 0],
    ],
  );
  const roles = galleryGroups([page], "roles", "all", expectations, doubts);
  assert.deepEqual(
    roles.map((g) => g.key),
    ["mark", "body"],
  );
  assert.deepEqual(stepGallery(types, NO_SELECTION, 1), sel([7]));
  assert.deepEqual(stepGallery(types, sel([6]), 1), sel([8]));
  assert.deepEqual(stepGallery(types, sel([8]), 1), sel([7]), "wraps");
  assert.deepEqual(stepGallery(types, sel([2]), 1, true), sel([8]), "next group");
}

// A type the text set counts as typed, until a person types it; and the engine's
// doubts are answered by agreeing examples or by the text.
{
  const byText = {
    ...blob(6, 350, "mark", 3),
    subtype: "smallLetter",
    subtype_explicit: false,
    subtype_source: "text" as const,
  };
  assert.equal(isTyped(byText), true);
  assert.equal(typedByText(byText), true);
  assert.equal(isTyped({ ...byText, subtype_source: undefined }), false);
  const page = line();
  page.blobs.push(byText);
  const retyped = setSubtype([page], sel([6]), "damma");
  assert.equal(typedByText(retyped[0].blobs.find((b) => b.id === 6)!), false);

  const alef = { ...blob(9, 200, "body", 1), body_score: 7, initial_role: "mark" as const };
  assert.equal(answeredBy(alef), null, "nothing answered it");
  assert.equal(answeredBy({ ...alef, proposed_role: "body" }), "examples");
  assert.equal(
    answeredBy({ ...alef, proposed_role: "body", explicit: true }),
    null,
    "a person decided",
  );
  assert.equal(answeredBy({ ...byText, initial_role: "body", decision_source: "text" }), "text");
  assert.equal(answeredBy(blob(1, 580, "body", 1)), null, "no doubt to answer");
}

// Pairs: marks printed as one are typed by their parts, in one fixed order.
{
  assert.equal(composeSubtype(["kasra", "hamza"]), "hamza+kasra");
  assert.equal(togglePart("hamza", "kasra"), "hamza+kasra");
  assert.equal(togglePart("hamza+kasra", "kasra"), "hamza");
  assert.equal(togglePart("hamza", "hamza"), "hamza", "a single type stays itself");
  const page = line();
  page.blobs.push({ ...blob(6, 350, "mark", 3), subtype: "hamza", subtype_explicit: true });
  const paired = addSubtypePart([page], sel([6]), "kasra", new Map());
  const mark = paired[0].blobs.find((b) => b.id === 6)!;
  assert.deepEqual(
    [mark.subtype, mark.subtype_explicit, mark.explicit],
    ["hamza+kasra", true, true],
  );
  // From an expected type, too.
  const guessed = expectationsOf([
    { snapshot_id: "s1", blob_id: 2, subtype: "hamza", confidence: 1, sure: true },
  ]);
  assert.equal(
    addSubtypePart([line()], sel([2]), "kasra", guessed)[0].blobs[1].subtype,
    "hamza+kasra",
  );
}

// The text's check: by word, and a word whose marks do not fit it is worth a look.
{
  const page = line();
  const checks = markChecksOf([
    { snapshot_id: "s1", word_id: 1, ok: true, missing: [], extra: [], disagree: [] },
    { snapshot_id: "s1", word_id: 2, ok: false, missing: ["sukun"], extra: [], disagree: [] },
  ]);
  assert.equal(markCheckOf("s1", 2, checks)?.missing[0], "sukun");
  assert.equal(markCheckOf("s1", null, checks), null);
  assert.deepEqual(wordRisks(page, page.words[0], checks), []);
  assert.deepEqual(wordRisks(page, page.words[1], checks), ["marks"]);
  assert.deepEqual(wordRisks(page, page.words[1]), [], "no checks, no such risk");
  assert.deepEqual([...tanweenOf([{ snapshot_id: "s1", blob_id: 4 }])], ["s1:4"]);
}

// A mixed body names the marks printed in it; they stay out of every mark count, and
// go when the flag does.
{
  const mixed = setException([line()], sel([3]), "mixed");
  const named = toggleFusedMark(toggleFusedMark(mixed, sel([3]), "fatha"), sel([3]), "shadda");
  assert.equal(pick(named, 3).subtype, "shadda+fatha");
  assert.equal(pick(named, 3).subtype_explicit, true);
  assert.equal(isTyped(pick(named, 3)), false, "a body is never a typed mark");
  assert.notEqual(
    typingSignature(named),
    typingSignature(mixed),
    "naming one asks for a new check",
  );
  assert.equal(pick(toggleFusedMark(named, sel([3]), "shadda"), 3).subtype, "fatha");
  assert.equal(
    pick(toggleFusedMark([line()], sel([3]), "fatha"), 3).subtype,
    "",
    "only a mixed body",
  );
  assert.equal(pick(setException(named, sel([3]), "broken"), 3).subtype, "");
}

// ── The labeling bar, and what a draft sends ───────────────────────────────
{
  const [base] = [line()];
  const body = (lines: CalibrationLine[]) => lines[0].blobs[0];
  const one = { snapshot: "s1", ids: [1] };

  // Two pieces: the body holds both, a person's decision, letters and all.
  const twoPieces: CalibrationLine = {
    ...base,
    words: base.words.map((entry) =>
      entry.word_id === 1 ? { ...entry, text: "إلا", pieces: ["إ", "لا"] } : entry,
    ),
  };
  const fused = applyContentsChip([twoPieces], one, {
    kind: "pieces",
    wordId: 1,
    start: 0,
    end: 2,
  });
  assert.equal(body(fused).exception, "fused");
  assert.deepEqual(body(fused).allocations, [{ word_id: 1, paws: 2 }]);
  assert.deepEqual(decidedOfBlob(body(fused)), { paws: ["إ", "لا"], marks: null });

  // A mark touching its letter: mixed, named; untick it, and the body is decided to hold none.
  const ringed = applyContentsChip([base], one, { kind: "mark", name: "roundZero" });
  assert.equal(body(ringed).exception, "mixed");
  assert.deepEqual(decidedOfBlob(body(ringed)), { paws: [null], marks: ["roundZero"] });
  const bare = applyContentsChip(ringed, one, { kind: "mark", name: "roundZero" });
  assert.equal(body(bare).exception, "");
  assert.deepEqual(decidedOfBlob(body(bare)), { paws: [null], marks: [] });

  // A mark chip on a mark types it.
  const typed = applyContentsChip(
    [base],
    { snapshot: "s1", ids: [2] },
    {
      kind: "mark",
      name: "fatha",
    },
  );
  assert.deepEqual(decidedOfBlob(typed[0].blobs[1]), { paws: [], marks: ["fatha"] });

  // Nothing decided sends nothing; and the editor's words come back from the server's parts.
  assert.equal(decidedOfBlob(base.blobs[0]), null);
  const arrived = readBlobFromServer({
    ...base.blobs[0],
    decided: { paws: [null], marks: [] },
    reading: { paws: ["ا"], marks: ["roundZero"] },
    contents: { paws: ["ا"], marks: [] },
  });
  assert.deepEqual(
    [arrived.explicit, arrived.subtype, arrived.subtype_explicit, arrived.exception],
    [true, "", true, ""],
  );
  const read = readBlobFromServer({
    ...base.blobs[0],
    reading: { paws: ["ا"], marks: ["roundZero"] },
    contents: { paws: ["ا"], marks: ["roundZero"] },
  });
  assert.deepEqual(
    [read.explicit, read.subtype, read.subtype_explicit, read.exception],
    [false, "roundZero", false, "mixed"],
  );
}

// ── A word's pieces, body by body ──────────────────────────────────────────
// Page 1's الرحمن as it was saved: the thin alef held two pieces, لر none.
{
  const alrahman = (): CalibrationLine => ({
    ...line(),
    blobs: [
      {
        ...blob(13, 560, "body", 1),
        allocations: [{ word_id: 1, paws: 2 }],
        explicit: true,
        ownership_explicit: true,
        decided: { paws: [null, null], marks: null },
        exception: "fused",
      },
      { ...blob(12, 500, "body", 1), allocations: [{ word_id: 1, paws: 0 }] },
      blob(19, 440, "body", 1),
    ],
    words: [{ ...word(1, 600, 440), pieces: ["ٱ", "لر", "حمن"], expected_paws: 3 }],
  });
  const runs = layWordPieces(alrahman(), 1, 3).runs;
  assert.deepEqual(
    runs.map((run) => [run.id, run.start, run.end]),
    [
      [13, 0, 2],
      [12, 2, 2],
      [19, 2, 3],
    ],
    "right to left, each its count",
  );

  // One click on لر gives it لر, and the alef only its own piece.
  const next = nextPieceRun(2, 2, 1);
  assert.deepEqual(next, [1, 2]);
  const fixed = applyContentsChip([alrahman()], sel([12]), {
    kind: "pieces",
    wordId: 1,
    start: 1,
    end: 2,
  });
  assert.deepEqual(pick(fixed, 12).allocations, [{ word_id: 1, paws: 1 }]);
  assert.deepEqual(decidedOfBlob(pick(fixed, 12)), { paws: ["لر"], marks: null });
  assert.deepEqual(pick(fixed, 13).allocations, [{ word_id: 1, paws: 1 }]);
  assert.equal(pick(fixed, 13).exception, "");
  assert.deepEqual(decidedOfBlob(pick(fixed, 13)), { paws: ["ٱ"], marks: null });
  assert.deepEqual(pick(fixed, 19).allocations, [{ word_id: 1, paws: 1 }]);
  assert.deepEqual(wordCount(fixed[0], fixed[0].words[0]), { got: 3, want: 3, ok: true });

  // A click next to the run joins it; a click at its end leaves it again.
  assert.deepEqual(nextPieceRun(1, 2, 2), [1, 3]);
  assert.deepEqual(nextPieceRun(1, 3, 2), [1, 2]);
  assert.deepEqual(nextPieceRun(1, 3, 1), [2, 3]);
  assert.equal(nextPieceRun(1, 2, 1), null, "a body keeps one piece");
  assert.deepEqual(nextPieceRun(0, 1, 2), [2, 3], "a piece apart is held alone");
  const joined = applyContentsChip(fixed, sel([12]), {
    kind: "pieces",
    wordId: 1,
    start: 1,
    end: 3,
  });
  assert.deepEqual(decidedOfBlob(pick(joined, 12)), { paws: ["لر", "حمن"], marks: null });
  assert.deepEqual(pick(joined, 19).allocations, [{ word_id: 1, paws: 0 }]);
  assert.equal(pick(joined, 19).explicit, false, "an undecided neighbour stays undecided");

  // Spreading: one each before more, the nearest first.
  assert.deepEqual(spreadPieces([2], 1), [1]);
  assert.deepEqual(spreadPieces([0, 0], 2), [1, 1]);
  assert.deepEqual(spreadPieces([1, 1], 3), [2, 1]);
  assert.deepEqual(spreadPieces([2, 1], 1), [0, 1]);
}

// What the reading says is never sent back as a person's decision.
{
  const read = readBlobFromServer({
    ...blob(1, 580, "body", 1),
    allocations: [{ word_id: 1, paws: 2 }],
    reading: { paws: ["إ", "لا"], marks: [] },
    contents: { paws: ["إ", "لا"], marks: [] },
  });
  assert.equal(read.exception, "fused", "shown as read");
  assert.equal(read.exception_read, true);
  assert.equal(decidedOfBlob(read), null, "nothing decided, nothing sent");
  const ringed = readBlobFromServer({
    ...blob(1, 580, "body", 1),
    reading: { paws: ["ا"], marks: ["roundZero"] },
    contents: { paws: ["ا"], marks: ["roundZero"] },
  });
  assert.equal(ringed.exception, "mixed");
  assert.equal(decidedOfBlob(ringed), null);
  const decided = readBlobFromServer({
    ...blob(1, 580, "body", 1),
    decided: { paws: [null, null], marks: null },
    contents: { paws: ["إ", "لا"], marks: [] },
  });
  assert.equal(decided.exception_read, false);
  assert.deepEqual(decidedOfBlob(decided), { paws: [null, null], marks: null });
  // Undo takes a body's pieces back to the reading.
  const undone = releaseDecisions([{ ...line(), blobs: [decided] }], sel([1]))[0].blobs[0];
  assert.equal(decidedOfBlob(undone), null);
}

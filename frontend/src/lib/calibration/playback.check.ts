// Run with node --experimental-strip-types src/lib/calibration/playback.check.ts.
import assert from "node:assert/strict";
import { MARK_INK, belongsAt, inkColor, playbackWords, wordBlobs, wordCrop } from "./playback.ts";
import type { CalibrationBlob, CalibrationLine, CalibrationWord } from "./types.ts";

function blob(id: number, role: "body" | "mark", owner: number | null): CalibrationBlob {
  return {
    id,
    role,
    initial_role: role,
    x: 110,
    y: 22,
    w: 4,
    h: 3,
    area: 12,
    body_score: role === "body" ? 13 : 2,
    explicit: false,
    ownership_explicit: false,
    subtype: "",
    exception: "",
    allocations: owner === null ? [] : [{ word_id: owner, paws: role === "body" ? 1 : 0 }],
    attention: [],
    decision_source: "search",
    proposed_role: null,
    proposal: {},
  };
}
const word: CalibrationWord = {
  word_id: 1,
  text: "first",
  aya: "2:1",
  expected_paws: 1,
  start_x: 120,
  end_x: 110,
  shared: false,
};
const second: CalibrationWord = { ...word, word_id: 2, text: "second", start_x: 110, end_x: 100 };
const line: CalibrationLine = {
  snapshot_id: "s1",
  line_id: "l1",
  page_number: 1,
  line_number: 1,
  bbox: { x: 100, y: 20, w: 30, h: 20 },
  band: [22, 35],
  readonly: false,
  approved: false,
  status: "exact",
  reason: null,
  words: [word, second],
  blobs: [
    blob(1, "body", 1),
    { ...blob(2, "mark", 1), x: 123, y: 20 },
    blob(3, "mark", null),
    blob(4, "body", 2),
  ],
};
const before = JSON.stringify(line);
const entries = playbackWords([
  { ...line, snapshot_id: "s2", line_number: 2 },
  { ...line, snapshot_id: "context", readonly: true },
  line,
]);
assert.deepEqual(
  entries.map((e) => [e.line.snapshot_id, e.word.word_id]),
  [
    ["s1", 1],
    ["s1", 2],
    ["s2", 1],
    ["s2", 2],
  ],
);
assert.deepEqual(
  wordBlobs(entries[0]).map((b) => b.id),
  [2, 1],
);
assert.deepEqual(wordBlobs({ line, word: { ...word, word_id: null }, wordIndex: 0 }), []);
assert.equal(
  belongsAt(line.blobs[1], word, 126),
  true,
  "owned marks outside a cut are still painted",
);
assert.equal(
  belongsAt(line.blobs[2], word, 115),
  false,
  "overlapping boxes do not create ownership",
);

const shared = {
  ...line.blobs[0],
  allocations: [
    { word_id: 1, paws: 1 },
    { word_id: 2, paws: 1 },
  ],
};
assert.equal(belongsAt(shared, word, 110), true);
assert.equal(belongsAt(shared, second, 110), false);
assert.equal(belongsAt(shared, second, 109), true);
// A body two words share is the first word's only right of the cut between them.
assert.equal(
  Array.from({ length: 30 }, (_, x) => belongsAt(shared, word, line.bbox.x + x)).filter(Boolean)
    .length,
  10,
);
assert.deepEqual(inkColor(line.blobs[1], "madda", false), MARK_INK);
assert.notDeepEqual(inkColor(line.blobs[1], "madda", true), inkColor(line.blobs[1], "fatha", true));
assert.deepEqual(inkColor(line.blobs[1], "unknown-type", true), MARK_INK);
const crop = wordCrop(entries[0]);
assert.ok(crop.x + line.bbox.x <= 110 && crop.x + crop.w + line.bbox.x >= 127);
assert.ok(crop.y === 0 && crop.y + crop.h <= line.bbox.h);
assert.equal(JSON.stringify(line), before, "playback must never mutate annotations");
console.log("Word playback checks passed.");

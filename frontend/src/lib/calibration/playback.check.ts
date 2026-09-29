// Run with node --experimental-strip-types src/lib/calibration/playback.check.ts.
import assert from "node:assert/strict";
import {
  BODY_INK,
  MARK_INK,
  TYPE_INK,
  belongsAt,
  containedPoint,
  inkColor,
  paintPlaybackInk,
  playbackWords,
  wordAtPixel,
  wordBlobs,
  wordCrop,
} from "./playback.ts";
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
  override: false,
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
assert.equal(wordAtPixel(entries, line, 3, 115), -1, "unassigned ink cannot select a false owner");
assert.equal(wordAtPixel(entries, line, 2, 126), 0);
assert.equal(wordAtPixel(entries, line, 0, 105), 1, "background navigation follows saved cuts");

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
const sharedLine = { ...line, blobs: [shared] };
const sharedPixels = paintPlaybackInk(
  new Uint32Array(30).fill(1),
  30,
  sharedLine,
  word,
  new Map(),
  false,
  true,
);
assert.equal(Array.from(sharedPixels).filter((n, i) => i % 4 === 3 && n === 255).length, 10);

const pixels = paintPlaybackInk(
  new Uint32Array([0, 1, 2, 3, 4, 999]),
  6,
  line,
  word,
  new Map([[2, "madda"]]),
  true,
  true,
);
assert.deepEqual(Array.from(pixels.slice(0, 4)), [0, 0, 0, 0]);
assert.deepEqual(Array.from(pixels.slice(4, 8)), [...BODY_INK, 255]);
assert.deepEqual(Array.from(pixels.slice(8, 12)), [...TYPE_INK.madda, 255]);
assert.equal(pixels[15], 70, "unassigned ink stays subdued");
assert.equal(pixels[19], 70, "other words stay subdued");
assert.deepEqual(Array.from(pixels.slice(20)), [0, 0, 0, 0]);
assert.deepEqual(inkColor(line.blobs[1], "madda", false), MARK_INK);
assert.notDeepEqual(inkColor(line.blobs[1], "madda", true), inkColor(line.blobs[1], "fatha", true));
assert.deepEqual(inkColor(line.blobs[1], "unknown-type", true), MARK_INK);
const crop = wordCrop(entries[0]);
assert.ok(crop.x + line.bbox.x <= 110 && crop.x + crop.w + line.bbox.x >= 127);
assert.ok(crop.y === 0 && crop.y + crop.h <= line.bbox.h);
assert.equal(JSON.stringify(line), before, "playback must never mutate annotations");
assert.deepEqual(containedPoint(60, 50, 120, 100, 80, 100), { x: 40, y: 50 });
assert.equal(containedPoint(10, 50, 120, 100, 80, 100), null);
assert.deepEqual(containedPoint(40, 50, 80, 100, 80, 80), { x: 40, y: 40 });
assert.equal(containedPoint(40, 5, 80, 100, 80, 80), null);
console.log("Word playback checks passed.");

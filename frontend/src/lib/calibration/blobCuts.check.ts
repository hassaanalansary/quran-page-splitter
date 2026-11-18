// Checks for the knife. Run with plain Node, like model.check.ts:
//
//     node src/lib/calibration/blobCuts.check.ts
//
// The fixture and every expected number are the same as in
// backend/core/tests/test_blob_cuts.py: the two sides must cut the same pixels.
// Silent on success, a stack trace on the first failure.
import assert from "node:assert/strict";

import {
  cutBlobInRaster,
  cutBlobIntoPieces,
  cutFitsBlob,
  judgeKnifeLine,
  pieceAt,
  pieceOfWord,
  swapPieceOwner,
} from "./blobCuts.ts";
import type { CalibrationBlob, CutLine } from "./types.ts";

// An alef standing on the tip of a bowl, a lam rising on the right: one blob.
const ART = [
  "....................",
  "..###.........####..",
  "..###.........####..",
  "..###.........####..",
  "..###.........####..",
  "..###.........####..",
  "..###.........####..",
  "..###.........####..",
  "..###.........####..",
  ".####.........####..",
  ".###..........####..",
  ".###..........####..",
  ".####.........####..",
  ".################...",
  "..##############....",
  "....................",
];
const WIDTH = ART[0].length;
const HEIGHT = ART.length;
const MASK = Uint8Array.from(ART.join(""), (ch) => (ch === "#" ? 1 : 0));

const boxesOf = (lines: CutLine[]) =>
  cutBlobIntoPieces(MASK, WIDTH, HEIGHT, lines).boxes.map((b) => [b.x, b.y, b.w, b.h, b.area]);
const rowOf = (lines: CutLine[], row: number) =>
  Array.from(
    cutBlobIntoPieces(MASK, WIDTH, HEIGHT, lines).labels.slice(row * WIDTH, (row + 1) * WIDTH),
    (v) => (v >= 0 ? String(v) : "."),
  ).join("");

// A flat cut under the alef: the bowl and lam first (they reach furthest right),
// then the alef. Nothing is lost: 92 + 24 is the blob's 116.
assert.deepEqual(boxesOf([[-1, 9, 6, 9]]), [
  [1, 1, 17, 14, 92],
  [2, 1, 3, 8, 24],
]);
assert.equal(rowOf([[-1, 9, 6, 9]], 8), "..111.........0000..");
assert.equal(rowOf([[-1, 9, 6, 9]], 9), ".0000.........0000..");
// A line that does not cross the ink through leaves one piece.
assert.deepEqual(boxesOf([[2, 0, 2, 3]]), [[1, 1, 17, 14, 116]]);
// A vertical cut: the right piece first.
assert.deepEqual(boxesOf([[9, -1, 9, 16]]), [
  [9, 1, 9, 14, 63],
  [1, 1, 8, 14, 53],
]);
// Two lines, three pieces.
assert.deepEqual(
  boxesOf([
    [-1, 9, 6, 9],
    [9, -1, 9, 16],
  ]),
  [
    [9, 1, 9, 14, 63],
    [1, 9, 8, 6, 29],
    [2, 1, 3, 8, 24],
  ],
);
// Any slope.
assert.deepEqual(boxesOf([[0, 6, 7, 12]]), [
  [1, 1, 17, 14, 93],
  [2, 1, 3, 8, 23],
]);
assert.equal(rowOf([[0, 6, 7, 12]], 8), "..011.........0000..");

// On a raster in page pixels: the line's crop starts at page (100, 20); the blob
// sits at (110, 30) inside it.
const origin = { x: 100, y: 20 };
const ids = new Uint32Array(40 * 30);
ART.forEach((row, y) =>
  [...row].forEach((ch, x) => {
    if (ch === "#") ids[(y + 10) * 40 + (x + 10)] = 7;
  }),
);
ids[0] = 9; // another blob's ink is not this one's
const blobBox = { id: 7, x: 111, y: 31, w: 17, h: 14 };
const pieces = cutBlobInRaster(ids, 40, 30, origin, blobBox, [[109, 39, 116, 39]]);
assert.deepEqual(
  pieces.boxes.map((b) => [b.x, b.y, b.w, b.h, b.area]),
  [
    [111, 31, 17, 14, 92],
    [112, 31, 3, 8, 24],
  ],
);
assert.equal(pieceAt(pieces, blobBox, 113, 32), 1);
assert.equal(pieceAt(pieces, blobBox, 125, 32), 0);
assert.equal(pieceAt(pieces, blobBox, 118, 32), -1);

// A cut fits its blob only while the blob is shared by exactly its words.
const blob = (extra: Partial<CalibrationBlob>): CalibrationBlob =>
  ({
    id: 7,
    x: 111,
    y: 31,
    w: 17,
    h: 14,
    area: 116,
    body_score: 12,
    role: "body",
    initial_role: "body",
    explicit: true,
    ownership_explicit: true,
    subtype: "",
    exception: "fused",
    allocations: [
      { word_id: 4, paws: 1 },
      { word_id: 5, paws: 1 },
    ],
    attention: [],
    decision_source: "human",
    proposed_role: null,
    proposal: {},
    ...extra,
  }) as CalibrationBlob;
const cut = { lines: [[109, 39, 116, 39]] as CutLine[], owners: [4, 5], pieces: pieces.boxes };
assert.equal(cutFitsBlob(blob({ cut })), true);
assert.equal(cutFitsBlob(blob({ cut: { ...cut, owners: [5, 4] } })), true);
assert.equal(cutFitsBlob(blob({ cut, allocations: [{ word_id: 4, paws: 1 }] })), false);
assert.equal(cutFitsBlob(blob({ cut, role: "mark" })), false);
assert.equal(cutFitsBlob(blob({ cut, erased: true })), false);
assert.equal(cutFitsBlob(blob({ cut: { ...cut, pieces: pieces.boxes.slice(1) } })), false);
assert.deepEqual(pieceOfWord(cut, 5), pieces.boxes[1]);
assert.equal(pieceOfWord(cut, 6), null);

// A click on a piece swaps its word with the next piece's.
assert.deepEqual(swapPieceOwner([4, 5], 0), [5, 4]);
assert.deepEqual(swapPieceOwner([4, 5], 1), [5, 4]);
assert.deepEqual(swapPieceOwner([4, 5, 6], 1), [4, 6, 5]);

// One more knife line: kept only when it splits off a new piece and not too many.
assert.equal(judgeKnifeLine(1, 1, 2), "nothing");
assert.equal(judgeKnifeLine(1, 2, 2), "done");
assert.equal(judgeKnifeLine(1, 3, 2), "too-many");
assert.equal(judgeKnifeLine(1, 2, 3), "more");
assert.equal(judgeKnifeLine(2, 2, 3), "nothing");
assert.equal(judgeKnifeLine(2, 3, 3), "done");

// A line across one corner chips off a single pixel: a crumb, not a piece. It goes
// back, with the line's own pixels, to the one piece there is.
const square = new Uint8Array(144).fill(1);
assert.deepEqual(
  cutBlobIntoPieces(square, 12, 12, [[-1, 3, 3, -1]]).boxes.map((b) => [
    b.x,
    b.y,
    b.w,
    b.h,
    b.area,
  ]),
  [[0, 0, 12, 12, 144]],
);

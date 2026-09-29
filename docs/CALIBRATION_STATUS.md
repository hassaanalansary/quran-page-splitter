# Calibration Implementation Status

Updated 2026-09-27. Calibration has not been validated and the entire staged plan
is not complete. Following explicit user direction, experimental application is
now available as a separate, off-by-default opt-in. See CALIBRATION_GUIDE.md.

## Available

- Words / Calibrate opens page processing, immutable full-line snapshots,
  exact-mask selection, classification, ownership and PAW contribution editing.
- Human constraints and shared-blob allocations survive snapshot preview.
  Accepting a preview saves its result as one undoable action. Discard saves nothing.
- Ordinary body reassignment recalculates word bounds; marks do not move bounds.
  Existing internal cuts in shared ink survive reassignment of other bodies.
- Draft revision checks, idempotent confirmation, retained labels and history,
  protected edited lines, and bundle/gallery-copy portability are implemented.
- Matching defaults to shadow mode. Inspector examples use the prediction's recorded
  profile, with links to the contributing pages. Shared words have individual PAW controls.
- Evaluation compares frozen, canonical and provisionally locked results against
  confirmed annotations. Per-page visual comparisons use retained line images and
  historical confirmed boundaries, not a current unsaved draft or fresh PDF render.
- A neighboring confirmation change invalidates preview context even when the ink
  geometry is unchanged. Reprocessing refreshes that context while retaining
  explicit decisions on unchanged target snapshots.

## Preservation And Verification

Migration 0026 was applied locally. All 55 edited lines on the existing mushaf
were archived; their word identities and boundaries were checked identical to
the live word rows after migration. No labels were invented for those archives.

The six real-input frozen benchmark reports in
`wl-out/bench/calibration-continuation-legacy/` are byte-identical to
`wl-out/bench/pre-calibration-v1/`: 123 lines and 958 returned words.
The separate canonical reports in `wl-out/bench/calibration-continuation-canonical/`
are byte-identical to the earlier `canonical-v1` reports. These counts describe
output coverage, not accuracy.

The broad backend run passed 588 tests on isolated SQLite. The new visual-comparison
API tests additionally verify retained-image use and separation of confirmed
boundaries from later draft edits. Frontend model checks, TypeScript, scoped ESLint,
Ruff, migration consistency and production builds were checked.

Live inspection covered stored-mask rendering, attention keyboard navigation,
body/mark editing, undo back to a clean draft, preview/discard, and a narrow viewport.
No page was confirmed for browser testing. The comparison dialog still needs live
inspection with genuinely confirmed pages; its API has synthetic regression coverage.

Known verification limitations:

- SQLite does not exercise PostgreSQL row-lock semantics or deferrable uniqueness.
  A threaded job test logged a SQLite table-lock exception although the suite passed.
- Mypy reports an existing nullable tuple return in `api/services/word_runs.py:263`.
  The checked calibration modules reported no additional errors.
- Vite reports the existing large-bundle warning. Build output is tracked by this repo.

## Evaluation Gate

Collect the first reviewed pages with separate Confirm and Process actions.
Before activation, evaluate later pages using only earlier approved samples,
inspect rendered comparisons, select/version thresholds on earlier folds, and
save and explicitly approve the report and configuration. The current metrics
and visual comparison are evaluation aids, not an activation approval mechanism.
Further workload/retry instrumentation and the saved approval workflow remain
part of that gate; insufficient evidence must leave shadow mode on.

Experimental automatic locking is available through an acknowledged settings switch.
It is not saved evaluation approval. Its profile keeps the distance/separation and
five-distinct-example gates, but allows support from one confirmed page. Human
constraints still win, and the canonical unlocked result remains stored separately.
Confirm & Next continuation jobs, validated activation/profile rollback, and batching
remain separate future work. Never train on unreviewed output.

## Review Ergonomics Follow-Up

- Multi-selection can filter marks/bodies; bulk mark typing ignores selected bodies.
- Explicit unassignment survives preview and reprocessing; glyph labels include Wasla.
- Near-black bodies and dark-pink marks replace green/blue; selected role outlines
  differ as well. Human classification resolves historical classifier attention flags.
- Preview retains failed readings and merges only affected ayat, including edits
  saved before preview. It no longer replaces unresolved assignments with empty lists.
- New-page subtype suggestions are distinct from explicitly accepted subtype samples.
- A dry-run-first, mandatory-backup restart command preserves old manual cuts.
  The real dry run listed 13 pages. No reset or real-page confirmation was performed.

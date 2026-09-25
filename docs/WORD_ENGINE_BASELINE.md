# Word Engine Pre-calibration Baseline v1

Frozen on 2026-09-25 under the local Git tag `word-engine-pre-calibration-v1`.
This is the comparison baseline for the next calibration phase, not a claim of
perfect recognition or that the engine cannot improve.

## Frozen Behavior

- Cross-line, aya-level search with geometry-aware states and same-line cuts.
- Soft component classification; promotion and demotion remain available.
- Existing band-coverage and nested-component scoring, with no further tuning.
- Known aya identities take precedence over inferred cursor positions, including
  leading separators and backward recovery. Backward recovery withdraws conflicting
  commits rather than returning duplicate word assignments.
- Endpoint preference preserves incomplete-result reporting. Completion and consumed
  counts refer to returned word placements, not cursor advancement across gaps.
- The debugger uses production commit traces, exact top-k enumeration, scoped
  component counts, image-coordinate overlays, and per-PAW cost breakdowns.

## Verification

- 80 engine, Arabic, input, trace, search, and debugger tests passed.
- 80 line-image, word-coordinate, and word-API integration tests passed using an
  isolated in-memory SQLite test database. PostgreSQL-specific deferrable uniqueness
  constraints were not exercised by this SQLite run.
- Ruff and `git diff --check` passed for the reviewed changes.
- Six real-page spans returned 958 distinct requested words across 123 lines.
  Their JSON reports were byte-identical to `codex-review-current`, before the
  final anchor-recovery fixes. The new edge cases are covered by regression tests.

| Span | Lines | Words Returned |
| --- | ---: | ---: |
| 1:1-1:7 | 7 | 29/29 |
| 2:1-2:30 | 55 | 450/450 |
| 7:196-7:206 | 15 | 125/125 |
| 55:1-55:30 | 17 | 123/123 |
| 78:1-78:40 | 20 | 173/173 |
| 112:1-114:6 | 9 | 58/58 |

The run reports 101 `exact` and 22 `scored` lines. These are engine diagnostics,
not independently measured accuracy. Every word remains subject to manual review.

## Reproduction

Run from `backend` with the existing environment and the same local database/PDF
inputs for mushaf `b9975701-a795-4b18-8c66-5551dd47aae1`:

```powershell
$env:PYTHONPATH = "."
uv run python ../wl-out/bench.py take b9975701 --tag pre-calibration-v1-recheck --spans 1:1-1:7 2:1-2:30 7:196-7:206 55:1-55:30 78:1-78:40 112:1-114:6
uv run python ../wl-out/paths.py b9975701 2:1-2:30 2:17 --top 100 --out ../wl-out/paths/pre-calibration-v1-recheck
uv run python -m unittest discover -s ../wl-out -p test_paths.py
```

The source helpers `wl-out/bench.py`, `wl-out/paths.py`, and `wl-out/test_paths.py`
are included in the freeze. Generated reports, images, and local input data are
not committed. The original verification reports are in `wl-out/bench/pre-calibration-v1`.

## Freeze Boundary

Do not retune this baseline while developing calibration. Compare subsequent
versions against it using manually confirmed component labels and word assignments.
The engine still assigns whole connected components and can produce incorrect
word placements even when counts match. Backward recovery can withdraw an entire
conflicting commit, including otherwise plausible placements within it.

The next step is planning calibration, not additional heuristic development.

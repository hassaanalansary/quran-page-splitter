# Celery + Docker: handoff

The plan is [plans/celery-and-docker.md](plans/celery-and-docker.md). This file is the live status: what is done, what was checked, and what was not.

## Status

Last updated: 2026-11-10.

| # | Phase | State | Checks run |
|---|---|---|---|
| 0 | Plan, this doc, the code style rules in `PROJECT_HANDOFF.md` §4 | done | none needed |
| 1 | Reorganize the job system (no behaviour change) | done | ruff, mypy, backend tests |
| 2 | Jobs described by their row | not started | |
| 3 | Celery | not started | |
| 4 | The real queue | not started | |
| 5 | Frontend | not started | |
| 6 | Docker | not started | |
| 7 | Docs | not started | |

## Where the work is

The build session could push to one branch only: **`claude/peaceful-turing-jnvd86`**. It starts at `be2683f`, the tip of `feature/celery-and-docker`, and adds one commit per phase. `feature/celery-and-docker` itself was not moved. To bring it up to date:

```bash
git fetch origin
git checkout feature/celery-and-docker
git merge --ff-only origin/claude/peaceful-turing-jnvd86
git push origin feature/celery-and-docker
```

## How the checks were run

In the cloud, on Linux, against a local PostgreSQL 16 with `DATABASE_URL` set in the environment.

| Check | Result on the base commit `be2683f` | What "passed" means below |
|---|---|---|
| `uv run ruff check .` | 1 error, in `core/word_boundary/separators.py` (RUF002) | no error besides that one |
| `uv run python -m mypy .` | 21 errors in 10 files | the same 21 errors, none new |
| `uv run python manage.py test --parallel 4` | 718 tests: 5 failures, 10 errors | the same 15 tests fail, none new |

The 15 tests that already fail on the base commit, none of them in the job system:

- 10 errors: `data_export.py` calls `calibration._fit_words`, which no longer exists. Every test in `test_data_export.py` that exports, and `EraseTests.test_the_data_export_says_a_png_was_cut_with_other_erases`.
- `PricingTests.test_a_page_with_a_library_is_read_with_its_answers_priced_in`
- `CalibrationPersistenceTests.test_page_deletion_keeps_numeric_review_identity`
- 3 in `test_logging_handlers.BlockedRolloverTests`. They test a Windows file lock and fail on Linux.

Two things to know when you run the tests yourself:

- With `--parallel`, one failing test crashes the whole run with `cannot pickle 'traceback' object`, unless `tblib` is installed. It is not in `pyproject.toml`. `uv pip install tblib` fixes it for one environment.
- One run here hung for five minutes on a query in the `quran` seeding tests. Autovacuum had analyzed a table while the test's rows were still uncommitted, so the planner expected 0 rows and chose a nested loop. `ALTER SYSTEM SET autovacuum = off` on the test server avoided it. It has nothing to do with this branch.

## What each phase did

### Phase 1: the job system reorganized

`api/services/jobs.py` is now the package `api/services/jobs/`, with the names of the plan's §4.3 and §4.4. Jobs still run on threads, and nothing behaves differently.

- `calibration.start_page` and `calibration_batch.start` / `_runner` moved to `jobs/kinds/`. `calibration.py` and `calibration_batch.py` no longer import the job system.
- The underscore functions that the job code calls became public: `calibration.find_aya_span_of_page` (was `_span_for_page`), `find_review_of_page` (`_review`), `are_line_snapshots_current` (`_sources_current`), `are_context_lines_current` (`_context_current`), and `calibration_batch.decide_batch_page_when_reached` (`_reach`).
- `queue.py`, `claiming.py`, `runner_registry.py`, `worker_events.py` and `api/tasks.py` do not exist yet. They arrive with the phase that needs them.

Choices made where the plan left a detail open:

- **Legacy names called through their module.** The job code imports the functions it calls by name (rule 7). Four older functions have generic names: `processing.preflight`, `processing.process`, `word_runs.preflight` and `calibration_batch.plan`. They are called as `module.function`, the way the plan's §4.5 writes `processing.preflight`. Renaming them belongs to the later backend reorganization.
- **The debug commands no longer delete job rows.** `debug_process` used to call `jobs.reset()`, which deleted every job in the database, before it started one. The plan moves that function to `api/tests/helpers.py` as `delete_all_jobs`, so the commands now follow the app's rules: a mushaf with an unfinished job is refused, and the command prints the refusal.
- **Runner inputs are still bound in phase 1.** `run_…_job` takes its inputs as arguments, bound with `functools.partial` in `start_…_job`. The job row has no `params` column until phase 2, where the runners start reading their inputs from the row.
- **The order of the refusals is unchanged in phase 1**, so that the phase changes no behaviour. Phase 4 moves the three admission rules to the front, as in the plan's §4.5.

## Not verified

- The Docker files will be written without being run. Their first real run is on the owner's machine (plan §9).

## For whoever continues

1. Read the plan, then this file.
2. Work on `feature/celery-and-docker` after the fast-forward above. One commit per phase. Push the branch; do not open a pull request.
3. Follow the plan's §8 (rules for the builder) and §4.1 (code style).
4. `backend/.env` is committed and may point `DATABASE_URL` at a Postgres on localhost. Set `DATABASE_URL` in the environment to use another one.
5. At the end of each phase, update the table above and the "Not verified" list.

# Celery + Docker: handoff

The plan is [plans/celery-and-docker.md](plans/celery-and-docker.md). This file is the live status: what is done, what was checked, and what was not.

## Status

Last updated: 2026-11-10.

| # | Phase | State | Checks run |
|---|---|---|---|
| 0 | Plan, this doc, the code style rules in `PROJECT_HANDOFF.md` §4 | done | none needed |
| 1 | Reorganize the job system (no behaviour change) | done | ruff, mypy, backend tests |
| 2 | Jobs described by their row | done | ruff, mypy, backend tests, the migration forward and back on a row of data |
| 3 | Celery | done | ruff, mypy, backend tests, and a real worker against a real Redis (see below) |
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
| `uv run python manage.py test --parallel 4` | 718 tests: 5 failures, 10 errors | the same 15 tests fail, none new (735 tests after phase 2, 749 after phase 3) |

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

### Phase 2: jobs described by their row

A job now starts `queued`, carries its runner's inputs in `params`, and a worker is handed its id and nothing else. Jobs still run on threads, so a job is `queued` only for the moment before its thread claims it.

- Migration `0033_job_described_by_its_row`: `started_at` → `requested_at` and `started_by` → `requested_by` (renames, the values are kept), plus `params`, `run_started_at`, `claimed_by_worker` and the `queued` state. Existing rows get `run_started_at = requested_at`. It was run forward, back and forward again on a row of data.
- New modules: `claiming.py` (`claim_queued_job`) and `runner_registry.py` (`JOB_RUNNER_PATHS`, `load_job_runner`). `execute_job(job_id, worker_name)` is now the plan's §4.5.
- `cancellation.cancel_job_before_it_starts` cancels a queued job at once. It uses the same condition as the claim, so a job is never both cancelled and started.
- `dead_jobs.py` has the two rules. `mark_silent_jobs_interrupted` now looks at running jobs only. `mark_unclaimed_jobs_interrupted` is new, with the setting `JOB_QUEUE_TIMEOUT_SECONDS` (default 600).
- The API's job object: `started_at` is replaced by `requested_at` and `run_started_at`. **The frontend source reads the new names from phase 5 on. The committed `frontend/dist` is older than that and needs `npm run build`.**

Choices made where the plan left a detail open:

- **How "a slot has been free for `JOB_QUEUE_TIMEOUT_SECONDS`" is decided.** It is read from the rows: fewer jobs than there are slots ran at any moment of that window. It can only err towards waiting longer.
- **What `params` holds.** Detection: the whole request body of `POST /process`. Calibration page: `page` and `expected_revision`. Calibration batch: `refresh`. The user comes from `requested_by`, and the page range from the row's own columns.
- **`phase` is untouched.** A queued job keeps the default `phase = "starting"`. The plan names no phase for the queue, and the state already says it.
- **`calibration_progress.cost`** now measures a page from `run_started_at`, so a wait in the queue is not counted as processing time.
- **`retype_from_text` and `restart_calibration`** refused to run beside a `running` job. They now refuse beside a queued one too.
- **Test tools moved to `api/tests/helpers.py`**: `FakeJobRunners`, `GatedRunner`, `create_job_row`, `wait_until_job_finished`. The later phases' tests share them.

### Phase 3: Celery

`JOB_RUNNER=celery` sends a job's id to a Celery worker through Redis. `thread` stays the default, so a checkout without Redis works as before.

- `config/celery.py` (the app), `config/__init__.py` (loads it), `api/tasks.py` (`run_job_task`, named `api.run_job`).
- `dispatch.py` picks `celery`, `thread` or `inline`. A job is handed over on commit. The task id is the job id.
- `worker_events.py`: on `worker_ready`, jobs queued for over a minute are sent again. On `worker_shutting_down`, the worker's own running jobs get the cancel flag. `ApiConfig.ready` connects both.
- Redis down at dispatch: the row is settled `error` and the request answers 503 (`job_queue_unavailable`, in English and Arabic).
- Settings: `JOB_RUNNER`, `CELERY_BROKER_URL` (default `redis://localhost:6379/0`), the Celery settings of the plan's §5.5, `JOB_QUEUE_TIMEOUT_SECONDS`, and `LOG_FILE` (default `quran.log`).
- `backend/pyproject.toml` gains `celery[redis]` (5.7.0 in `uv.lock`). `gunicorn`, `whitenoise` and `flower` come with phase 6.

Checked by hand in the cloud, with `redis-server` and `celery -A config worker --concurrency 2` on Linux:

| What | Result |
|---|---|
| A detection job through the real queue | The request returned in 0.07 s with `queued`. The row went `queued` → `running` → settled in 0.44 s, `claimed_by_worker = celery@e2e`, and the worker's log named the task by the job's id |
| SIGTERM to the worker | Celery logged a warm shutdown, and only the running job claimed by that worker got `cancel_requested` |
| Worker start with a queued job that had no message | `Dispatched 1 waiting job(s) again`, and the job ran |
| Redis stopped, then a new job | 503 after 0.68 s, and the row settled `error` |

Choices made where the plan left a detail open:

- **`job_runner` replaces `inline`** as the per-call override of `start_…_job` and `dispatch_job`. The debug commands pass `INLINE` or `THREAD`.
- **`JOB_RUNNER=inline` is accepted too**, beside `PROCESS_JOBS_INLINE`, which still wins over `JOB_RUNNER`.
- **Threads are also started on commit**, like the Celery send. `debug_process --rollback --via job-thread` therefore refuses to start: its thread could never see the job. Use `--via job-inline` with `--rollback`.
- **Calibration jobs now fill `stopped_on_page` when they are cancelled**: the page itself for a page job, the first unfinished page for a batch. Detection already did. This is what the plan's §5.3 point 6 asks of a job that a stopping worker cancels.
- **The signal receivers close the database connection of the worker's main process** when they are done, so that worker children forked later never inherit one.
- **`CELERY_BROKER_TRANSPORT_OPTIONS = {"socket_connect_timeout": 5}`** and **`CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True`** are not in the plan's table. The first bounds how long a request waits for an unreachable Redis. The second makes a worker that starts before Redis keep trying.

## Not verified

- The Docker files will be written without being run. Their first real run is on the owner's machine (plan §9).
- A long job across a worker stop. The stop hook was seen to flag the right row, and every runner is tested to stop on the flag. A real multi-page run that is cancelled by `docker compose restart celeryworker` and settles `cancelled` with a resume page was not run: the cloud has no real mushaf (plan §9, step 7).
- Two jobs at once in two worker children, each with its own run log (plan §9, step 10).

## For whoever continues

1. Read the plan, then this file.
2. Work on `feature/celery-and-docker` after the fast-forward above. One commit per phase. Push the branch; do not open a pull request.
3. Follow the plan's §8 (rules for the builder) and §4.1 (code style).
4. `backend/.env` is committed and may point `DATABASE_URL` at a Postgres on localhost. Set `DATABASE_URL` in the environment to use another one.
5. At the end of each phase, update the table above and the "Not verified" list.

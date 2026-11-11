# Celery + Docker: handoff

The plan is [plans/celery-and-docker.md](plans/celery-and-docker.md). This file is the live status: what is done, what was checked, and what was not.

## Status

Last updated: 2026-11-11. **All seven phases are done.** Start with [On your Ubuntu machine](#on-your-ubuntu-machine).

| # | Phase | State | Checks run |
|---|---|---|---|
| 0 | Plan, this doc, the code style rules in `PROJECT_HANDOFF.md` §4 | done | none needed |
| 1 | Reorganize the job system (no behaviour change) | done | ruff, mypy, backend tests |
| 2 | Jobs described by their row | done | ruff, mypy, backend tests, the migration forward and back on a row of data |
| 3 | Celery | done | ruff, mypy, backend tests, and a real worker against a real Redis (see below) |
| 4 | The real queue | done | ruff, mypy, backend tests |
| 5 | Frontend | done | `npx tsc --noEmit`, `npm run lint`, and the process screen in a real browser (see below) |
| 6 | Docker | done | every image built, and both stacks started and used, in the cloud (see below). ruff, mypy, backend tests, `tsc`, lint |
| 7 | Docs | done | the links and commands in the docs were checked against the files |

## On your Ubuntu machine

In this order:

1. **Bring `feature/celery-and-docker` up to date** with the commands under [Where the work is](#where-the-work-is).
2. **Rebuild the frontend bundle.** `frontend/dist` is committed and older than this work: it still reads `started_at` and knows no `queued` state. Run `npm run build` in `frontend/` before Django serves it. Vite in development and the production nginx image both build from source and are not affected.
3. **Rename two settings** if your `backend/.env` or any other env file sets them: `MAX_CONCURRENT_JOBS` → `JOB_WORKER_SLOTS`, `MAX_CONCURRENT_JOBS_PER_USER` → `MAX_ACTIVE_JOBS_PER_USER`. The old names are no longer read. The committed `backend/.env` sets neither.
4. **Install Docker Engine with the Compose plugin, and `just`.** Then follow the README's *Run it with Docker* section: `just build`, `just up`, `just manage seed_quran` or your own data with `just restore-db`.
5. **Run the plan's §9 checks**, steps 1 to 11. Most of them already passed in the cloud (see phase 6), but not on your machine, your user and your data. The [Not verified](#not-verified) list says what was never run anywhere.
6. **For production**, follow [DEPLOY.md](../DEPLOY.md). It is §9 step 12.

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
| `uv run python manage.py test --parallel 4` | 718 tests: 5 failures, 10 errors | the same 15 tests fail, none new (735 tests after phase 2, 749 after phase 3, 763 after phase 4) |

The 15 tests that already fail on the base commit, none of them in the job system:

- 10 errors: `data_export.py` calls `calibration._fit_words`, which no longer exists. Every test in `test_data_export.py` that exports, and `EraseTests.test_the_data_export_says_a_png_was_cut_with_other_erases`.
- `PricingTests.test_a_page_with_a_library_is_read_with_its_answers_priced_in`
- `CalibrationPersistenceTests.test_page_deletion_keeps_numeric_review_identity`
- 3 in `test_logging_handlers.BlockedRolloverTests`. They test a Windows file lock and fail on Linux.

Two things to know when you run the tests yourself:

- With `--parallel`, one failing test crashes the whole run with `cannot pickle 'traceback' object`, unless `tblib` is installed. It was added to the dev group in phase 6, so `uv sync` installs it.
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

### Phase 4: the real queue

Behind a Celery worker, a job that finds every slot busy now waits its turn. On threads nothing can wait, so such a job is still refused with 429, as before.

- The settings were renamed, with no fallback to the old names: `MAX_CONCURRENT_JOBS` → `JOB_WORKER_SLOTS`, `MAX_CONCURRENT_JOBS_PER_USER` → `MAX_ACTIVE_JOBS_PER_USER`. `MAX_QUEUED_JOBS` (default 20) is new. **If an `.env` of yours sets the old names, rename them there.** The committed `backend/.env` sets neither.
- `admission.py` holds the three rules of the plan's §5.2. Every `start_…_job` now calls them first, in the order of §4.5: the mushaf, the user, the queue, and then the kind's own checks.
- `queue.py`: `count_jobs_ahead_in_queue` and `count_queued_jobs`. The job object of the API gains `queue_position`: the number of queued jobs requested earlier, or null for a job that is not queued.
- New message `job_queue_full`, and `too_many_jobs_for_user` now says "running or waiting". Both in English and Arabic.

Choices made where the plan left a detail open:

- **Thread and inline mode keep the old 429.** `refuse_if_queue_is_full` reads the runner: with Celery it counts the waiting jobs against `MAX_QUEUED_JOBS`, and without a queue it counts the active jobs against `JOB_WORKER_SLOTS`.
- **A limit of 0 is switched off**, as the two old limits already were. That holds for `MAX_QUEUED_JOBS` too: 0 means no limit, not "nothing may wait".
- **Running jobs are not "ahead" in the queue.** `queue_position` counts queued jobs only, as §5.2 words it. A job with position 0 is next, but it still waits while every slot is busy.
- **The refusals changed order for the calibration jobs.** A page or a batch on a mushaf that already has a job now answers 409 before it looks at the page or the range.
- **The thread tests pin `JOB_RUNNER="thread"`.** `just test` runs inside a container whose environment says `celery`, and those tests would otherwise publish to the real Redis.

### Phase 5: the frontend

The screens that show a job now know the `queued` state.

- `lib/api/types.ts`: the `queued` state, `queue_position`, and `requested_at` + `run_started_at` in place of `started_at`. `isJobRunning` is renamed `isJobActive` (queued or running). `isJobQueued` and `didJobNeverStart` are new.
- `lib/jobQueue.ts`: `queuedJobLabel`, the one place that words "Queued, 2 ahead of you" and "Queued, next in line".
- Process screen: the run card, the note under it, the caption under the stop button, the cancel dialog (no ledger for a job that has not started), and the outcome of a job that was cancelled in the queue or that no worker picked up.
- Calibration: a queued page job and a queued batch show the queue label, not a 0% bar.
- New strings, each in `en.ts` and `ar.ts`: `jobQueue.ahead`, `jobQueue.next`, `process.queuedNote`, `process.cancelQueuedIntro`, `process.cancelQueuedToast`, `process.cancelQueuedStatus`, `process.cancelQueuedLead`, `process.unclaimedToast`.

Checks: `npx tsc --noEmit` passed. `npm run lint` gave 0 errors and 6 warnings, all in `components/ui/` files this branch does not touch.

Checked in a real browser in the cloud (Vite dev server, Django with `JOB_RUNNER=celery`, a local Redis, no worker, three queued jobs):

| What | Result |
|---|---|
| The third job's process screen | "Queued, 2 ahead of you", with the waiting note |
| The first job's process screen | "Queued, next in line" |
| Stop a queued job from the screen | The dialog said it only leaves the queue. After it: the outcome card, the status line and the toast for a job that never started |
| The same screen in Arabic | "في قائمة الانتظار، 1 قبلك", right to left |

**`frontend/dist` is committed and was not rebuilt.** It still reads `started_at` and knows no `queued` state. Run `npm run build` in `frontend/` before you serve the bundle.

Choices made where the plan left a detail open:

- **No elapsed timer exists in the frontend**, so nothing reads `run_started_at` for one. The field is in the type, and `didJobNeverStart` reads it.
- **The strings carry no plural forms**, like the rest of both locale files: "Queued, 1 ahead of you" is the same sentence as for 2.

### Phase 6: Docker

The plan expected the Docker files to be written without being run. They were run: a Docker daemon works in the cloud session, so every image was built and both stacks were started and used. Two real bugs came out of that, and both are fixed.

Files, as in the plan's §6.1: `docker-compose.local.yml`, `docker-compose.production.yml`, `justfile`, `DEPLOY.md`, `.dockerignore`, `.gitattributes`, `.envs/.local/`, `.envs/.production.example/`, and `compose/`. Code changes: `VITE_API_PROXY` in `frontend/vite.config.ts`, WhiteNoise and `STATIC_ROOT` when `DEBUG` is off, the `TRUST_PROXY_SSL_HEADER` switch, and `gunicorn`, `whitenoise`, `flower` and `tblib` in `backend/pyproject.toml`.

**The local stack** (`just build`, `just up`):

| What | Result |
|---|---|
| The four services | Up. Django migrated and answered. The worker connected to Redis and registered `api.run_job` |
| `just psql`, `just redis-cli`, `just shell`, `just manage check` | Each worked. `localhost:5433` and `localhost:6380` answered from the host |
| A detection job through the containers | `queued` → `running` → settled, claimed by `celery@<container>` |
| `docker compose restart django` during a run | The run continued: page 5 before, page 10 after |
| `docker compose restart celeryworker` during a run | The job settled `cancelled`, 15 pages saved, `stopped_on_page = 16`, in under 4 seconds. The worker came back |
| A `.py` file saved during a run | The same: `cancelled` with a page to resume from, and the worker restarted |
| Both slots busy, then two more jobs | `queue_position` 0 and 1. Both started when the slots came free |
| Cancel a running job, then a queued one | The running one stopped at its next page. The queued one was `cancelled` at once and never claimed |
| The worker stopped, then a job, polled past the queue timeout | `interrupted`, "No worker picked this job up." |
| `just test` | 763 tests, the same 15 failures as on the base commit |
| `just check` | Both tools ran: ruff's 1 known error, mypy's 21 known errors |
| `just dump-db`, then rows deleted, then `just restore-db` | The rows came back, with the stack running |
| A dump from **Postgres 16 at migration 0032**, through `just restore-db` | Restored into Postgres 18 and migrated. The old job row kept its values under the new column names |
| The containers as uid 1000 | Both ran, a job ran, and the files it wrote belong to uid 1000 |
| `just flower`, and `--profile frontend` | Flower answered on 5555. Vite in the container answered on 5173 and proxied `/api` to `django` |

The runs that lasted a while used a stand-in for the line engine, mounted from outside the repo: one "page" every two seconds, with the real runner's contract (progress per page, the cancel flag read between pages). The cloud has no real mushaf.

**The production stack** (example values, the made-up domain `satr.test`, requests sent to Traefik on 127.0.0.1):

| What | Result |
|---|---|
| The images | All built, the React build inside the nginx image included |
| `manage.py check --deploy` | One warning, W008 (`SECURE_SSL_REDIRECT`). It is expected: Traefik does the redirect |
| `http://` | 301 to `https://` |
| `/`, and a page of the app such as `/mushafs/x` | 200, the React app |
| `/api/suras` | 200 |
| `/admin/login/`, and `/static/admin/css/base.css` | 200 and 200: the admin has its CSS |
| `/_allauth/browser/v1/auth/session` | The `csrftoken` cookie, marked `Secure`, and an HSTS header: Django knows the request was HTTPS |
| A hashed asset | 200, `immutable`, gzip |
| Sign in, then upload a PDF | 200, then 201. nginx served the new thumbnail from the media volume |
| A job on the production worker | Ran. The web container served the run log that the worker wrote |
| `docker compose stop celeryworker` | A warm shutdown, 2.4 seconds |
| The backup script, and the media move of `DEPLOY.md` | Both worked |

**The two bugs that running it found:**

1. **nginx kept the old address of the django container.** The plan's `upstream django { server django:5000; }` is resolved once, when nginx starts. After a deploy replaced the django container, every API call answered 502 until nginx was restarted. `default.conf` now puts the address in a variable and names Docker's DNS server, so nginx asks again while it runs. Checked by forcing the container onto a new address: 200 from the first request.
2. **`docker compose exec` skips the entrypoint**, and the entrypoint is what sets `DATABASE_URL`. A shell opened with `exec` read the localhost address in `backend/.env` and found no database. `just shell` now goes through `/entrypoint`, and `DEPLOY.md` says which form to use.

Choices made where the plan left a detail open, or where its draft could not stand:

- **The base image is `python:3.13.13-slim-bookworm` with a pinned `uv` binary copied in** (`ghcr.io/astral-sh/uv:0.11.32`). The draft's `ghcr.io/astral-sh/uv:python3.13-bookworm-slim` is not pinned, and it is stale: that tag still holds uv 0.9.30, because the bookworm variant is no longer published.
- **No `wait-for-it`, and no `apt-get` at all in the django images.** The entrypoint waits with a few lines of Python and `psycopg`, which is already installed. The import check `import cv2, fitz, psycopg` passes on the slim image without any system package.
- **Pinned versions**, read from the registries on 2026-11-10: `postgres:18` (19 is at rc1, so 18 is the newest stable major), `redis:8.10.3-alpine`, `nginx:1.30.6-alpine`, `traefik:v3.7.10`, `node:24.22.2-bookworm-slim`.
- **The Postgres volume is mounted at `/var/lib/postgresql`**, the folder above the data, as the image's documentation asks since version 18. The data is at `/var/lib/postgresql/18/docker` inside it.
- **`client_max_body_size` is `2g`, not the draft's `500m`.** The plan says to match the app's upload limit, and the app has none. A scanned mushaf can pass 500 MB, and the cost of a limit that is too low is a failed upload.
- **`TRUST_PROXY_SSL_HEADER`** is the name of the proxy-header switch. It is a true/false setting, so that no header name has to be typed into an env file.
- **WhiteNoise is added only when `DEBUG` is off.** With `DEBUG` on, `runserver` serves static files itself, and WhiteNoise would warn about a missing folder on every start.
- **`restore` drops the database and creates it again**, with `dropdb --force`, where the plan's outline said `pg_restore --clean`. A restore over existing tables leaves behind whatever the dump does not know. `just restore-db` then runs `migrate`.
- **Production Redis keeps its data on disk** (`--appendonly yes`, its own volume), so a job that waits in the queue survives a restart of Redis.
- **`gunicorn --no-control-socket`.** gunicorn 27 opens a control socket in the home folder of its user, and the image's `django` user has none. It logged an error on every start.
- **`just test` gives the tests threads and an in-memory cache**, not the stack's worker and Redis.
- **`just check` runs both tools even when ruff fails.** ruff always reports its one known error in `core/`, and mypy would never have run.
- **`tblib` joined the dev group.** With 15 failing tests on the base commit, `--parallel` crashes without it.
- **Flower listens on 127.0.0.1 only.** It has no login. Django's 8000 and the optional Vite's 5173 are published as the plan wrote them.
- **The local worker's `stop_grace_period` is 3 minutes**, longer than the 120 seconds the start script gives a job to reach its next page. With Docker's default of 10 seconds, `restart celeryworker` would kill the job.

The cloud session intercepts HTTPS with its own certificate authority, which containers do not trust, and Docker Hub rate-limited it. The builds there used a registry mirror and local copies of the Python and Node base images that trust that authority. Nothing of that is in the repo: the committed Dockerfiles are the ones that were built.

### Phase 7: the docs

- `README.md`: the jobs and serving paragraphs, a *Run it with Docker* section (the usual way now, with the `just` recipes), *Run it without Docker* (with how to start a worker beside `runserver`), and a link to `DEPLOY.md`.
- `docs/PROJECT_HANDOFF.md`: the jobs and serving paragraphs of §2, the repo layout and the services table of §3, the Docker commands and the line-endings note of §4, the `ProcessJob` row of §5, the status codes of `POST /process` in §6, and where each kind of job lives in §8.
- `backend/.env.dist`: `JOB_RUNNER`, `CELERY_BROKER_URL`, the three renamed and new limits, `JOB_QUEUE_TIMEOUT_SECONDS`, `TRUST_PROXY_SSL_HEADER` and `LOG_FILE`.
- This file.

`docs/ENGINES_FLOW.md` was not touched (plan §8). It still quotes the old names in its walk-through of a calibration page: `calibration_service.start_page`, `jobs.start_words`, `jobs._touch`, `jobs.settle` and `_execute`. They are now `start_calibration_page_job`, `create_queued_job`, `record_job_progress`, `record_job_outcome` and `execute_job` (plan §4.4). The engine steps it describes are unchanged.

## Not verified

- **Docker on your Ubuntu machine.** Both stacks ran in the cloud, as root and as uid 1000, but not on your machine with your user, your Docker version and your data. Plan §9 steps 1 to 11 are still yours to run.
- **The Let's Encrypt certificate.** Traefik started and routed, but it could not ask for a certificate: there is no public domain in the cloud. The HTTPS checks above used Traefik's own self-signed certificate.
- **A real mushaf**: a PDF of real size through Traefik and nginx, real pages through the line and word engines in a worker child, and how much memory that takes.
- A long job of the **real engine** across a worker stop. The stop, the save of a `.py` file and the cancel were all run against a real worker, but with the stand-in runner described under phase 6 (plan §9, step 7).
- Two jobs at once in two worker children, each with its own run log (plan §9, step 10).
- A queued job on the calibration screens. The page job and the batch got the same label as the process screen, and `tsc` and the linter pass, but only the process screen was opened in a browser.
- "N ahead of you" **in the browser against a real worker**. The queue itself was run against a real worker (phase 6), and the label was seen in a browser with queued rows (phase 5), but not the two together.

## Found on the way, not fixed

Out of this branch's scope, and each worth its own change:

- **The full data export is broken on the base commit.** `data_export.py` calls `calibration._fit_words`, which no longer exists. 10 of the 15 failing tests are this.
- `PricingTests.test_a_page_with_a_library_is_read_with_its_answers_priced_in` and `CalibrationPersistenceTests.test_page_deletion_keeps_numeric_review_identity` fail on the base commit.
- The 3 `BlockedRolloverTests` fail on Linux. They test a Windows file lock: they need a skip on other systems.
- ruff's one error (RUF002, an Arabic digit in a docstring of `core/word_boundary/separators.py`) and mypy's 21 errors are all on the base commit. `core/` is frozen (plan §8).
- `docs/ENGINES_FLOW.md` quotes the old job names (see phase 7).

## For whoever continues

1. Read the plan, then this file.
2. Work on `feature/celery-and-docker` after the fast-forward above. Push the branch; do not open a pull request until the owner asks.
3. Follow `docs/PROJECT_HANDOFF.md` §4 (code style).
4. `backend/.env` is committed and may point `DATABASE_URL` at a Postgres on localhost. Set `DATABASE_URL` in the environment to use another one.
5. The next steps belong to the owner: the list under [On your Ubuntu machine](#on-your-ubuntu-machine).

# Celery jobs, a real queue, Docker, and a reorganized job system

Approved on 2026-11-10. Live status: [CELERY_DOCKER_HANDOFF.md](../CELERY_DOCKER_HANDOFF.md).

## 0. Summary

Processing runs (page detection, one calibration page, a calibration batch) run today on a daemon thread inside the web process (`backend/api/services/jobs.py`). The job's state, progress, cancel flag and heartbeat already live in the `ProcessJob` row, so the only thing still tied to the web process is who runs the work. This work changes four things:

1. Jobs run in a Celery worker, with Redis as the broker. Threads stay as a fallback for a checkout without Redis.
2. When every worker slot is busy, a job waits in a real queue.
3. The job system is split into small modules with descriptive names (§4).
4. The project gets Docker, for local work and for production (§6).

What the worker process buys:

| Concern | Threads (before) | Celery worker (after) |
|---|---|---|
| A web reload or a deploy | kills the run; the mushaf stays blocked for up to 5 minutes | the run continues |
| CPU work | shares the web process with every request | its own processes |
| A crash inside OpenCV | takes the web server down | takes one worker child down |
| Two runs at once | each run log also receives the other run's trace | each run log holds its own trace |
| Every slot busy | 429, try again later | the job waits its turn |
| Extra services | none | Redis and the worker |

## 1. Decisions

| # | Decision |
|---|---|
| – | Celery + Redis, Linux only |
| C2 | Reorganize the job system and what it calls. `calibration.py` and the rest of the backend come later, on their own branch |
| C3 | Threads stay as a no-Redis fallback |
| C4 | A real queue |
| C5 | Vite runs on the host. A `frontend` container exists behind `--profile frontend` |
| C6 | nginx + Traefik containers in production |
| C7 | Postgres: the newest stable major, pinned by number (`postgres:18` at the time of writing) |
| C8 | A stopping worker lets its job stop at the next page |
| C9 | No database GUI container. Local Postgres is published on localhost for any client |
| C10 | The dev worker restarts on save, and a running job stops at its next page |

## 2. Branch and workflow

- Branch `feature/celery-and-docker`, cut from `feature/word-by-word_recognition` at `df4e918`.
- One commit per phase (§7).
- Push the branch. Do not open a pull request until the owner asks: opening one posts to the team Slack and runs the org checks.
- Every check that could not be run is listed in the handoff doc.

## 3. Moving a working copy to another machine

Git does not carry these:

| What | How |
|---|---|
| The database | `pg_dump -Fc` on the old machine, then `just restore-db quran.dump` (§6.6) |
| `backend/media/` | copy by hand |
| `wl-out/`, `data/` | copy by hand if they are still needed |

The repository stores LF line endings, so a Linux checkout needs no conversion.

---

## 4. Code organization

### 4.1 Rules (written into `docs/PROJECT_HANDOFF.md` §4, because `CLAUDE.md` is gitignored here)

1. **A function name says what it does to what**: verb + object + qualifier. `mark_silent_jobs_interrupted`, not `_settle_dead_jobs`. `record_job_progress`, not `_touch`.
2. **No generic names**: `run`, `start`, `get`, `process`, `to_dict`, `helpers`, `utils`.
3. **No leading-underscore functions.** A helper that only makes sense inside one function is inlined. Any other helper gets a real name and a home module.
4. **One module, one job.** The module docstring says where it sits in the flow. Entry points come first, in call order.
5. **A use case is one function whose body is the list of steps** (§4.5).
6. **No closures that hide inputs.** A job runner reads its inputs from the job row.
7. **Callers import the function they call**: `from api.services.jobs.cancellation import request_job_cancellation`.

### 4.2 Private functions: my position

You are right for this codebase, and I won't argue for keeping them. The underscore was meant to say "detail, not an entry point". In practice it failed: `jobs._touch` is called from `calibration.py`, and `calibration._sources_current` from `calibration_batch.py`, so the mark is already untrue.

One thing has to replace it. Without the underscore, a reader still needs to tell entry points from details. Small modules do that job: every function in `cancellation.py` is about cancelling, and the file is short enough to read whole.

### 4.3 New layout

```
backend/api/
  tasks.py                       run_job_task                the Celery task: one line, calls execute_job
  services/jobs/
    __init__.py                  docstring only: the map of this package and the flow diagram
    states.py                    TERMINAL_STATES, is_job_finished
    serializers.py               serialize_job
    queries.py                   find_job_by_id, find_latest_job_of_mushaf, find_active_job_of_mushaf, is_job_settled
    admission.py                 refuse_if_mushaf_has_active_job, refuse_if_user_has_too_many_jobs, refuse_if_queue_is_full
    queue.py                     count_jobs_ahead_in_queue
    creation.py                  create_queued_job
    dispatch.py                  dispatch_job                inline, thread, or send to Celery
    claiming.py                  claim_queued_job
    execution.py                 execute_job
    runner_registry.py           JOB_RUNNER_PATHS, load_job_runner
    progress.py                  record_job_progress, record_job_outcome
    cancellation.py              request_job_cancellation, is_job_cancellation_requested, cancel_job_before_it_starts
    dead_jobs.py                 mark_silent_jobs_interrupted, mark_unclaimed_jobs_interrupted
    worker_events.py             what happens when a worker starts or stops
    kinds/
      detection.py               start_detection_job, run_detection_job
      calibration_page.py        start_calibration_page_job, run_calibration_page_job
      calibration_batch.py       start_calibration_batch_job, run_calibration_batch_job
```

Each file in `kinds/` holds both halves of one job, so you read one kind top to bottom in one place. The domain services (`calibration.py`, `calibration_batch.py`, `processing.py`) stop importing the job system. They no longer know they run as a job.

### 4.4 Old name → new name

| Today | New | Module |
|---|---|---|
| `jobs.start` | `start_detection_job` | `kinds/detection.py` |
| `jobs._processing_runner(…).run` | `run_detection_job` | `kinds/detection.py` |
| `calibration.start_page` | `start_calibration_page_job` | `kinds/calibration_page.py` |
| the `run` closure inside it | `run_calibration_page_job` | `kinds/calibration_page.py` |
| `calibration_batch.start` | `start_calibration_batch_job` | `kinds/calibration_batch.py` |
| `calibration_batch._runner(…).run` | `run_calibration_batch_job` | `kinds/calibration_batch.py` |
| `jobs.start_words`, `jobs.start_pages` | `create_queued_job` | `creation.py` |
| `jobs._launch` | `dispatch_job` | `dispatch.py` |
| `jobs._execute` | `execute_job` | `execution.py` |
| `jobs._touch` | `record_job_progress` | `progress.py` |
| `jobs.settle` | `record_job_outcome` | `progress.py` |
| `jobs.ensure_idle` | `refuse_if_mushaf_has_active_job` | `admission.py` |
| `jobs._ensure_capacity` | `refuse_if_user_has_too_many_jobs`, `refuse_if_queue_is_full` | `admission.py` |
| `jobs._settle_dead_jobs` | `mark_silent_jobs_interrupted` | `dead_jobs.py` |
| `jobs.request_cancel` | `request_job_cancellation` | `cancellation.py` |
| `jobs.cancel_requested` | `is_job_cancellation_requested` | `cancellation.py` |
| `jobs.get`, `latest_for`, `active_for`, `is_settled` | `find_job_by_id`, `find_latest_job_of_mushaf`, `find_active_job_of_mushaf`, `is_job_settled` | `queries.py` |
| `jobs.to_dict` | `serialize_job` | `serializers.py` |
| `jobs.reset` | `delete_all_jobs` | `api/tests/helpers.py` |

Underscore functions that the job code calls across modules become public, with names the builder confirms against their use: `calibration._span_for_page`, `_review`, `_sources_current`, `_context_current`, and `calibration_batch._reach`.

### 4.5 What a flow reads like

```python
def start_detection_job(mushaf, detection_settings, user):
    refuse_if_mushaf_has_active_job(mushaf.id)
    refuse_if_user_has_too_many_jobs(user)
    refuse_if_queue_is_full()
    processing.preflight(mushaf, first_page, last_page)
    job = create_queued_job(kind=DETECTION, mushaf=mushaf, requested_by=user, params=detection_settings, …)
    dispatch_job(job)
    return job


def execute_job(job_id, worker_name):
    job = claim_queued_job(job_id, worker_name)
    if job is None:          # cancelled while queued, or delivered twice
        return
    run_the_job = load_job_runner(job.kind)
    try:
        run_the_job(job)
    except Exception as error:
        record_job_outcome(job.id, ERROR, error=str(error))
```

---

## 5. Celery design

```
 browser       django                      redis           celeryworker (prefork children)
 POST ───────▶ start_detection_job()
               ├ refuse_if_… (409 / 429)
               ├ create_queued_job  (state=queued, params={…})
               └ dispatch_job ─ on_commit ─▶ [queue] ─▶ run_job_task(job_id)
 ◀─ 202 queued, "2 ahead of you"                        └ execute_job
 GET poll ───▶ reads the row ◀──────── row updates ───────  ├ claim_queued_job   queued → running
 cancel ─────▶ sets the flag, or cancels a queued row       ├ run_…_job(job)
                                                            └ record_job_outcome
```

The message carries only the job id. The row carries everything else, so there is no Celery result backend. Endpoints and polling do not change.

### 5.1 Model (`backend/api/models.py`, plus the next `api` migration)

- `ProcessJobStateChoices.QUEUED`, the new default state. It is not terminal, so the one-job-per-mushaf rule still counts it.
- `params` (JSON): the runner's inputs.
- `started_at` is renamed `requested_at`, and `started_by` is renamed `requested_by`. A queued job has been requested but has not started.
- `run_started_at` (new): when a worker began. The frontend's elapsed timer reads this one.
- `claimed_by_worker` (new): which worker has it.

### 5.2 The queue

| Rule | Setting | Over the limit |
|---|---|---|
| One active job per mushaf, queued or running | – | 409, as today |
| Jobs running at once | `JOB_WORKER_SLOTS` (was `MAX_CONCURRENT_JOBS`), also the worker's `--concurrency` | the job waits in the queue |
| Active jobs per user, queued + running | `MAX_ACTIVE_JOBS_PER_USER` (was `MAX_CONCURRENT_JOBS_PER_USER`), default 1 | 429 |
| Jobs waiting | `MAX_QUEUED_JOBS`, default 20 | 429 "the queue is full" |

- The job response gains `queue_position`: how many queued jobs were requested before this one. The UI shows "Queued, 2 ahead of you".
- Order is first come, first served.

### 5.3 Behaviour

1. **Claim.** `claim_queued_job` is one conditional `UPDATE … WHERE state = 'queued'`. If it changes no row, the task returns. A duplicate message is harmless.
2. **Cancel.** A queued job is cancelled directly. A running job still stops at its next page or line, through the flag.
3. **Silent jobs.** A running job with no heartbeat for `JOB_HEARTBEAT_TIMEOUT_SECONDS` becomes `interrupted`, as today.
4. **Unclaimed jobs.** A queued job may wait hours behind long runs, so waiting alone is not an error. It becomes `interrupted` ("No worker picked this job up") only when a worker slot has been free for `JOB_QUEUE_TIMEOUT_SECONDS` (default 600) and nothing claimed it.
5. **Redis down at dispatch.** The row is settled `error` and the request returns 503.
6. **Worker stop.** On `worker_shutting_down`, the worker's running jobs get the cancel flag. They stop at the next page and settle `cancelled` with `stopped_on_page`. A crash (out of memory, a segfault) gives no such chance, and the job ends as `interrupted`.
7. **Lost messages.** On `worker_ready`, queued rows older than a minute are dispatched again. The claim makes this safe.

### 5.4 Three ways to run a job

| `JOB_RUNNER` | Who runs it | Queue |
|---|---|---|
| `celery` (set by compose) | a Celery worker | yes |
| `thread` (default without Docker) | a thread in the web process, as today | no: over `JOB_WORKER_SLOTS` it answers 429, as today |
| inline (`PROCESS_JOBS_INLINE`) | the request itself; tests and the debug commands | no |

### 5.5 Settings (`backend/config/settings.py`, wired in a new `backend/config/celery.py`)

| Setting | Value | Why |
|---|---|---|
| `CELERY_BROKER_URL` | `redis://redis:6379/0` from the environment | |
| `CELERY_TASK_IGNORE_RESULT` | `True` | the row is the result |
| `CELERY_TASK_ACKS_LATE` | `False` | With Redis, an unacknowledged task that runs longer than 1 hour is delivered again. Whole-mushaf runs take longer than that |
| `CELERY_WORKER_PREFETCH_MULTIPLIER` | `1` | a busy child must not hold queued jobs |
| `CELERY_WORKER_HIJACK_ROOT_LOGGER` | `False` | Celery would otherwise remove Django's log handlers |
| serializer | JSON only | |

**Logging.** A `LOG_FILE` setting gives the worker its own `logs/worker.log`. Run logs under `logs/runs/` stay as they are. With one job per worker child, each run log holds only its own trace.

**OpenCV.** `cv2.ocl` is only touched inside a run (`core/imaging/accel.py`), so it initializes in the worker child. The containers have no GPU, so they run on the CPU path. The env files set `OPENCV_ACCEL=cpu` to make that explicit.

---

## 6. Docker (the cookiecutter-django layout, plus Redis and a Celery worker)

### 6.1 Files

```
docker-compose.local.yml
docker-compose.production.yml
justfile
DEPLOY.md
.dockerignore
.gitattributes                         *.sh and the start scripts stay LF
.envs/
  .local/.django   .local/.postgres                        tracked, throwaway values
  .production.example/.django   .postgres   server.env     tracked templates
  .production/                                             gitignored, lives on the server
compose/
  local/
    django/Dockerfile   django/start
    django/celery/worker/start
    node/Dockerfile                                        only for --profile frontend
  production/
    django/Dockerfile   django/entrypoint   django/start
    django/celery/worker/start
    nginx/Dockerfile    nginx/default.conf                 builds the React app and serves it
    traefik/Dockerfile  traefik/dynamic.yml                HTTPS and Let's Encrypt
    postgres/Dockerfile postgres/maintenance/…             backup and restore scripts
```

### 6.2 Services

```
 local                                              production

 browser ─▶ Vite on the host :5173                  browser ─▶ traefik :80 / :443
              │ proxies /api /media …                            │
              ▼                                                  ▼
           django :8000 (runserver)                           nginx ── serves the React build and /media
              │                                                  │ proxies /api /admin /static /_allauth /accounts
              ├──▶ postgres  ◀── just psql                       ▼
              │                                               django :5000 (gunicorn)
              └──▶ redis ──▶ celeryworker                        ├──▶ postgres
                    ▲                                            └──▶ redis ──▶ celeryworker
                    └── just redis-cli
```

| Service | Local | Production |
|---|---|---|
| `django` | `runserver`, source mounted | gunicorn on `:5000` |
| `celeryworker` | Celery through `watchfiles` (restarts on save) | Celery, `stop_grace_period: 10m` |
| `postgres` | `postgres:18`, published on `127.0.0.1:5433` | not published |
| `redis` | published on `127.0.0.1:6380` | not published |
| `frontend` | only with `--profile frontend` | – |
| `flower` | only with `--profile tools` | – |
| `nginx` | – | see Appendix A |
| `traefik` | – | ports 80 and 443, file provider, HTTP challenge (Appendix A) |

The local ports are one above the standard ones, so they never clash with a Postgres or Redis installed on the machine.

### 6.3 What differs from a plain cookiecutter-django setup

1. `redis` and `celeryworker` are new. Both `start` scripts for the worker live under `django/celery/worker/`.
2. nginx also proxies `/_allauth/` and `/accounts/` (sign-in and the Google callback).
3. nginx serves `/media/` straight from the media volume. Media is public today, and this keeps it so.
4. nginx's `client_max_body_size` is sized for mushaf PDFs, and `proxy_read_timeout` is longer for the exports. The builder reads the app's upload limit and matches it.
5. `django` and `celeryworker` share the media and logs volumes.
6. Local Postgres and Redis are published on localhost, for your VS Code extension.
7. Vite runs on the host by default. The optional `frontend` service reads `VITE_API_PROXY`.

### 6.4 The doors

| Command | What it opens |
|---|---|
| `just psql` | An interactive `psql` inside the `postgres` container, as the right user on the right database |
| `just redis-cli` | An interactive `redis-cli` inside the `redis` container |
| `just shell` | `bash` inside the `django` container |
| `just manage shell` | The Django shell |
| `localhost:5433`, with the user, password and database from `.envs/.local/.postgres` | The same database from your VS Code extension |

`manage.py dbshell` needs the `psql` program inside the django image, and a slim image does not have it. `just psql` runs inside the `postgres` container, which always has it:

```
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Other recipes: `build`, `up`, `down`, `prune`, `logs`, `manage`, `npm`, `check`, `check-frontend`, plus `test`, `dump-db`, `restore-db`, `flower`.

### 6.5 Code changes that Docker needs

- `frontend/vite.config.ts`: the proxy target reads `VITE_API_PROXY`, defaulting to `http://localhost:8000`. `changeOrigin: false` stays.
- `backend/pyproject.toml`: add `celery[redis]`, `gunicorn`, `whitenoise`, and `flower` in the dev group.
- `backend/config/settings.py`:
  - `STATIC_ROOT` + WhiteNoise. Today nothing serves `/static/` when `DEBUG` is off, so the admin has no CSS in production.
  - `SECURE_PROXY_SSL_HEADER` from the environment, so Django knows the request was HTTPS behind Traefik.
- `CACHE_URL` points at Redis, so allauth's rate limits are shared across processes. `settings.py` already asks for this.
- Values from the compose env files win over `backend/.env`. `backend/.env` keeps serving a run without Docker.

Details the builder keeps:
- The virtualenv lives outside the mounted source (`UV_PROJECT_ENVIRONMENT=/venv`).
- Local containers run as your user id, so files written to `backend/media` and `backend/logs` belong to you.
- The entrypoint builds `DATABASE_URL` from the `POSTGRES_*` variables and waits for Postgres.
- The image build ends with `python -c "import cv2, fitz, psycopg"`, so a missing system library fails the build, not the first request.
- Images are pinned by number, never `latest`.
- Migrations: the local `start` runs `migrate`. A production deploy runs `migrate` before `up -d`.
- With nginx serving `index.html`, the CSRF cookie comes from the first `/_allauth/…/session` call, exactly as it does behind Vite today.

### 6.6 Moving the data

1. On Windows: `pg_dump -Fc -d <your db> -f quran.dump`.
2. On Ubuntu: `just up`, then `just restore-db quran.dump`. A dump restores into the same Postgres major or a newer one.
3. Copy `backend/media/` into the clone.

---

## 7. Phases (one commit each)

| # | Phase | Behaviour change |
|---|---|---|
| 0 | Plan, handoff doc, and the style rules in `docs/PROJECT_HANDOFF.md` | none |
| 1 | Reorganize the job system into `services/jobs/` with the new names; still threads | none |
| 2 | Jobs described by their row: `QUEUED`, `params`, claim, the field renames, queued-cancel, dead-job rules | jobs pass through `queued` |
| 3 | Celery: `config/celery.py`, `api/tasks.py`, `JOB_RUNNER`, worker events | jobs run in the worker when `JOB_RUNNER=celery` |
| 4 | The real queue: the three admission rules, `queue_position`, renamed settings | over the slots, a job waits |
| 5 | Frontend: the `queued` state, "N ahead of you", the renamed fields, in `en.ts` and `ar.ts` | new labels |
| 6 | Docker: compose files, the `compose/` folder, `.envs/`, `justfile`, `DEPLOY.md`, Vite proxy target, WhiteNoise | none in the app |
| 7 | Docs: README, `docs/PROJECT_HANDOFF.md`, `.env.dist`, the handoff doc | none |

Phase 1 comes first on purpose. The renames land in their own commit, so the Celery commit shows only the Celery change.

## 8. Rules for the session that builds this

- Never run `npm run build`, and never commit `frontend/dist`. You build it yourself.
- Do not edit anything under `backend/core/`. Engine behaviour is frozen.
- Do not edit `docs/ENGINES_FLOW.md`.
- Every new frontend string goes into both `en.ts` and `ar.ts`.
- Static checks, from `backend/`: `uv run ruff check .`, `uv run python -m mypy .`. From `frontend/`: `npx tsc --noEmit`, `npm run lint`.
- Tests: `uv run python manage.py test --parallel 4`, on Postgres. Never two runs against one database.
- Push the branch only. No pull request.
- After adding files, check `git status`: this repo's `.gitignore` is broad (`*.txt`, `build/`, `logs`).
- The handoff doc lists every check that was not run.

## 9. Verification

**In the cloud:** the static checks above, plus the backend tests if a Postgres is available. New tests cover:
- a job claimed twice runs once
- cancel while queued
- the silent-job and unclaimed-job rules
- each kind runs from its row alone
- the three admission rules and `queue_position`
- dispatch happens after commit, with the task id equal to the job id
- Redis down gives 503 and an `error` row
- the worker-stop hook flags only that worker's jobs
- thread mode still answers 429 over the slots

**By you on Ubuntu** (the first time Docker actually runs):
1. `just build`, then `just up`. `docker compose ps` shows every service up.
2. `just psql` and `just redis-cli` open interactive sessions.
3. Restore the data, then `npm run dev` and open `http://localhost:5173`.
4. Start a detection run: `queued` → `running` within about a second.
5. With both slots busy, start a third job on another mushaf: "Queued, 1 ahead of you", and it starts when a slot frees.
6. `docker compose restart django` mid-run: the run continues.
7. Save a `.py` file mid-run, or `docker compose restart celeryworker`: the job settles `cancelled` with a resume page.
8. Cancel a running job, then cancel a queued one.
9. Stop the worker and start a job: it waits, then shows the no-worker message.
10. Two mushafs at once: each run log holds only its own trace.
11. `just test` passes inside the container.
12. Production, on the server: follow `DEPLOY.md`. The site answers on HTTPS, a PDF upload succeeds, and the admin has its CSS.

---

## Appendix A. Reference drafts for the Docker files

These are starting points, written without being run. The builder adjusts them, and the first real run happens on the owner's machine (§9).

### A.1 `compose/production/nginx/default.conf`

```nginx
upstream django {
  server django:5000;
}

server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  # Mushaf PDFs are large. Match the app's own upload limit.
  client_max_body_size 500m;

  gzip on;
  gzip_comp_level 5;
  gzip_min_length 1024;
  gzip_proxied any;
  gzip_vary on;
  gzip_types application/javascript application/json text/css image/svg+xml;

  # Django: the API, the admin and its static files, allauth's JSON API and
  # the OAuth callbacks. Traefik sets X-Forwarded-For and X-Forwarded-Proto.
  location ~ ^/(api|admin|static|_allauth|accounts)/ {
    proxy_pass http://django;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    # Exports and bundles are streamed and can take minutes.
    proxy_read_timeout 300s;
  }

  # Uploads, template crops and exported images. Public today (Django serves
  # them without a login), so nginx serves them straight from the volume.
  location /media/ {
    alias /usr/share/nginx/media/;
  }

  # Hashed build assets never change.
  location /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Every other path is a page of the React app.
  location / {
    try_files $uri /index.html;
    add_header Cache-Control "no-cache";
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "same-origin" always;
    add_header X-Frame-Options "DENY" always;
  }
}
```

### A.2 `compose/production/nginx/Dockerfile`

```dockerfile
# Build the React app; only its static files reach the final image.
FROM docker.io/node:24-bookworm-slim AS frontend-build-stage
WORKDIR /app/frontend
COPY ./frontend/package.json ./frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ./frontend ./
RUN npm run build

FROM docker.io/nginx:<pinned>-alpine
COPY ./compose/production/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build-stage /app/frontend/dist /usr/share/nginx/html
```

### A.3 Traefik

`compose/production/traefik/Dockerfile`:

```dockerfile
FROM docker.io/traefik:<pinned v3>
RUN mkdir -p /etc/traefik/acme \
  && touch /etc/traefik/acme/acme.json \
  && chmod 600 /etc/traefik/acme/acme.json
COPY ./compose/production/traefik/dynamic.yml /etc/traefik/dynamic.yml
```

`compose/production/traefik/dynamic.yml`:

```yaml
http:
  routers:
    app:
      rule: 'Host(`{{ env "APP_DOMAIN" }}`)'
      entryPoints:
        - web-secure
      service: nginx
      tls:
        certResolver: letsencrypt
  services:
    nginx:
      loadBalancer:
        servers:
          - url: http://nginx:80
```

The `traefik` service in `docker-compose.production.yml`:

```yaml
  traefik:
    build:
      context: .
      dockerfile: ./compose/production/traefik/Dockerfile
    restart: unless-stopped
    depends_on:
      - nginx
    environment:
      APP_DOMAIN: ${APP_DOMAIN:?Set APP_DOMAIN in the server's .env}
    command:
      - --providers.file.filename=/etc/traefik/dynamic.yml
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=web-secure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.web-secure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL:?Set ACME_EMAIL in the server's .env}
      - --certificatesresolvers.letsencrypt.acme.storage=/etc/traefik/acme/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
    volumes:
      - production_traefik:/etc/traefik/acme
    ports:
      - "0.0.0.0:80:80"
      - "0.0.0.0:443:443"
```

### A.4 `compose/production/django/Dockerfile`

```dockerfile
# Build stage: the dependencies.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS python-build-stage
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
  --mount=type=bind,source=backend/uv.lock,target=uv.lock \
  --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
  uv sync --locked --no-install-project --no-dev
COPY ./backend /app

# Run stage: no compilers, no build tools.
FROM python:3.13-slim-bookworm AS python-run-stage
WORKDIR /app
RUN addgroup --system django && adduser --system --ingroup django django
RUN apt-get update && apt-get install --no-install-recommends -y wait-for-it \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=django:django ./compose/production/django/entrypoint /entrypoint
COPY --chown=django:django ./compose/production/django/start /start
COPY --chown=django:django ./compose/production/django/celery/worker/start /start-celeryworker
RUN sed -i 's/\r$//g' /entrypoint /start /start-celeryworker \
  && chmod +x /entrypoint /start /start-celeryworker
COPY --from=python-build-stage --chown=django:django /app /app
# Docker seeds a new volume from these folders. They must belong to the user
# the container runs as, or every upload fails.
RUN mkdir -p /app/media /app/logs /app/staticfiles \
  && chown django:django /app /app/media /app/logs /app/staticfiles
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
# Fail the build, not the first request, if a system library is missing.
RUN python -c "import cv2, fitz, psycopg"
USER django
ENTRYPOINT ["/entrypoint"]
```

The local image (`compose/local/django/Dockerfile`) uses the uv image directly, sets `UV_PROJECT_ENVIRONMENT=/venv` so the environment lives outside the mounted source, runs `uv sync --locked --no-install-project` with the dev group, and copies the same entrypoint plus the local `start` scripts.

### A.5 Scripts

`compose/production/django/entrypoint`:

```bash
#!/bin/bash
set -o errexit
set -o pipefail
set -o nounset

export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
wait-for-it "${POSTGRES_HOST}:${POSTGRES_PORT}" -t 30
exec "$@"
```

`compose/production/django/start`:

```bash
#!/bin/bash
set -o errexit
set -o pipefail
set -o nounset

# Migrations are not run here: a deploy runs `migrate` before `up -d`.
python /app/manage.py collectstatic --noinput
exec gunicorn config.wsgi \
  --bind 0.0.0.0:5000 \
  --chdir=/app \
  --workers "${GUNICORN_WORKERS:-3}" \
  --threads "${GUNICORN_THREADS:-4}" \
  --timeout 120 \
  --access-logfile -
```

`compose/production/django/celery/worker/start`:

```bash
#!/bin/bash
set -o errexit
set -o pipefail
set -o nounset

exec celery -A config worker \
  --loglevel info \
  --concurrency "${JOB_WORKER_SLOTS:-2}" \
  --max-tasks-per-child 10
```

`compose/local/django/start` runs `python manage.py migrate` and then `exec python manage.py runserver 0.0.0.0:8000`.

`compose/local/django/celery/worker/start` wraps the same Celery command in `watchfiles --filter python`, with a stop timeout long enough for one page. Check `watchfiles --help` for the exact flag, and check which signal makes Celery stop warmly.

### A.6 `docker-compose.local.yml`, in outline

```yaml
services:
  django:        # build compose/local/django; volumes .:/app:z; working_dir /app/backend
                 # env_file .envs/.local/.django + .postgres; ports 8000:8000; command /start
  celeryworker:  # same image and mounts as django; command /start-celeryworker; no ports
  postgres:      # build compose/production/postgres (postgres:18)
                 # volume local_postgres_data:/var/lib/postgresql/18/docker
                 # ports 127.0.0.1:5433:5432
  redis:         # pinned redis image; ports 127.0.0.1:6380:6379
  frontend:      # profiles: [frontend]; build compose/local/node; VITE_API_PROXY=http://django:8000
                 # ports 5173:5173; command npm run dev -- --host 0.0.0.0
  flower:        # profiles: [tools]; same image as django; ports 5555:5555
```

`django` and `celeryworker` run as the host user (`user: "${HOST_UID:-1000}:${HOST_GID:-1000}"`, exported by the `justfile`), so files they write under `backend/media` and `backend/logs` belong to the developer.

The official Postgres image keeps its data under `/var/lib/postgresql/<major>/docker` since version 18. Check the image's documentation for the major you pin.

### A.7 Env files

`.envs/.local/.django`: `SECRET_KEY` (a throwaway value), `DEBUG=True`, `ALLOWED_HOSTS=localhost,127.0.0.1,django`, `JOB_RUNNER=celery`, `JOB_WORKER_SLOTS=2`, `CELERY_BROKER_URL=redis://redis:6379/0`, `CACHE_URL=redis://redis:6379/1`, `OPENCV_ACCEL=cpu`.

`.envs/.local/.postgres`: `POSTGRES_HOST=postgres`, `POSTGRES_PORT=5432`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.

`.envs/.production.example/` holds the same keys with placeholders, plus `server.env` with `APP_DOMAIN` and `ACME_EMAIL`. Production also sets `DEBUG=False`, `SECURE_SSL_REDIRECT=False` (Traefik redirects) and the proxy-header switch.

### A.8 `justfile`, in outline

```just
export COMPOSE_FILE := "docker-compose.local.yml"
export HOST_UID := `id -u`
export HOST_GID := `id -g`

build *args:      docker compose build {{args}}
up:               docker compose up -d --remove-orphans
down:             docker compose down
prune *args:      docker compose down -v {{args}}
logs *args:       docker compose logs -f {{args}}
manage +args:     docker compose run --rm django python manage.py {{args}}
shell:            docker compose exec django bash
psql:             docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
redis-cli:        docker compose exec redis redis-cli
test *args:       docker compose run --rm django python manage.py test --parallel 4 {{args}}
dump-db file:     pg_dump -Fc inside the postgres container, copied out to {{file}}
restore-db file:  copy {{file}} in, then pg_restore --clean --if-exists --no-owner
flower:           docker compose --profile tools up -d flower
```

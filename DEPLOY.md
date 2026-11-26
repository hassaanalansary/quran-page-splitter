# Deploying SATR with Docker

How to run the production stack on one Linux server. For work on your own machine see the *Docker* section of [README.md](README.md).

The files were built and run in the cloud, but never on a real server with a real domain. The first deploy is the first full test: see [What was not tested](#what-was-not-tested).

## What runs

```
 browser ─▶ traefik :80 / :443          HTTPS, the Let's Encrypt certificate
              │
              ▼
            nginx ── serves the React build and /media
              │ proxies /api /admin /static /_allauth /accounts
              ▼
           django :5000 (gunicorn) ──▶ postgres
              │
              └──▶ redis ──▶ celeryworker
```

| Service | What it does | Keeps its data in the volume |
|---|---|---|
| `traefik` | The only service with open ports: 80 and 443. Gets and renews the certificate, redirects http to https | `production_traefik` (the certificate) |
| `nginx` | Serves the React app, which is built into its image, and `/media`. Passes the rest to Django | – |
| `django` | The API and the admin, under gunicorn | `production_django_media`, `production_django_logs` |
| `celeryworker` | Runs the processing jobs. Shares both volumes with `django` | the same two |
| `postgres` | The database, Postgres 18 | `production_postgres_data`, `production_postgres_data_backups` |
| `redis` | The job queue and the cache | `production_redis_data` |

## What the server needs

- Linux with Docker Engine and the Compose plugin (`docker compose version` answers).
- A domain whose DNS record points at the server. Let's Encrypt checks the domain over port 80, so the record must exist before the first start.
- Ports 80 and 443 open to the internet. No other port is published.
- `git`, to fetch the code.

## First deploy

**1. Get the code.**

```bash
git clone https://github.com/hassaanalansary/quran-page-splitter.git
```

```bash
cd quran-page-splitter
```

**2. Write the settings.** The real values live in `.envs/.production/`, which is gitignored and never leaves the server.

```bash
cp -r .envs/.production.example .envs/.production
```

Then edit the three files and replace every `CHANGE-ME`:

| File | What to set |
|---|---|
| `.envs/.production/server.env` | `APP_DOMAIN` (the domain, no scheme) and `ACME_EMAIL` |
| `.envs/.production/.django` | `SECRET_KEY`, `ALLOWED_HOSTS` (the same domain), `CSRF_TRUSTED_ORIGINS` (`https://` + the domain). Email and Google sign-in if you use them |
| `.envs/.production/.postgres` | `POSTGRES_PASSWORD`. Letters and digits only |

Each file says how to generate its secret.

**3. Tell Compose which files to use.** Do this in every new terminal, or put both lines in the server user's `~/.bashrc`.

```bash
export COMPOSE_FILE=docker-compose.production.yml
```

```bash
export COMPOSE_ENV_FILES=.envs/.production/server.env
```

**4. Build the images.** The nginx image builds the React app, so this takes a few minutes.

```bash
docker compose build
```

**5. Create the database tables.** This starts Postgres and Redis too.

```bash
docker compose run --rm django python manage.py migrate
```

**6. Fill the database.** Either load the Quran reference data into the empty database:

```bash
docker compose run --rm django python manage.py seed_quran
```

or bring your existing data instead: see [Moving your data to the server](#moving-your-data-to-the-server).

**7. Create an admin account.**

```bash
docker compose run --rm django python manage.py createsuperuser
```

**8. Start everything.**

```bash
docker compose up -d
```

**9. Check it.**

```bash
docker compose ps
```

Every service should be `running`. Then open `https://<your domain>`. The first request can take up to a minute while Traefik gets the certificate. Check these three, in this order:

1. The site answers on HTTPS, and `http://` redirects to it.
2. `https://<your domain>/admin/` shows the login page **with its styling**. A plain unstyled page means the static files are not served.
3. Upload a mushaf PDF. A `413` error means the PDF is over nginx's limit: see [Settings worth knowing](#settings-worth-knowing).

If the certificate does not arrive, read Traefik's log. The usual causes are a DNS record that does not point here yet, or a closed port 80.

```bash
docker compose logs traefik
```

## Deploying a new version

```bash
git pull
```

```bash
docker compose build
```

```bash
docker compose run --rm django python manage.py migrate
```

```bash
docker compose up -d
```

`up -d` replaces only the containers whose image changed. When it replaces the worker, the worker asks its running jobs to stop at their next page and waits up to 10 minutes for them. Such a job ends as `cancelled` with a page to resume from. Jobs that were still waiting in the queue stay queued and start when the new worker is up.

## Moving your data to the server

Git carries neither the database nor the uploaded files.

**The database.** On the machine that has the data, make a dump in Postgres's custom format:

```bash
pg_dump -Fc -d quran -f quran.dump
```

Copy `quran.dump` to the server, then load it. **This replaces the server's database.**

```bash
docker compose up -d postgres
```

```bash
docker compose cp quran.dump postgres:/backups/quran.dump
```

```bash
docker compose exec postgres restore quran.dump
```

```bash
docker compose run --rm django python manage.py migrate
```

The last command matters: a dump from an older version of the code lacks the newer migrations. A dump restores into the same Postgres major version or a newer one, never an older one.

**The uploaded files.** Copy the old machine's `backend/media/` folder to the server as `media/`, then into the volume, and give the files to the user the app runs as:

```bash
docker compose up -d django
```

```bash
docker compose cp ./media/. django:/app/media/
```

```bash
docker compose exec --user root django chown -R django:django /app/media
```

## Backups

```bash
docker compose exec postgres backup
```

writes `/backups/backup_<date>.dump` into the `production_postgres_data_backups` volume. List them, and copy one off the server:

```bash
docker compose exec postgres backups
```

```bash
docker compose cp postgres:/backups/backup_2026_11_10T03_00_00.dump .
```

The volume is on the same disk as the database, so a backup that never leaves the server does not survive a lost disk. The uploaded files are not in the dump: back up the `production_django_media` volume too.

Restore with the same `restore` command as above.

## Everyday commands

All of them need the two `export` lines of step 3.

| To do this | Run |
|---|---|
| Follow the logs of everything | `docker compose logs -f` |
| Follow one service | `docker compose logs -f celeryworker` |
| Run a `manage.py` command | `docker compose run --rm django python manage.py <command>` |
| Open the Django shell | `docker compose run --rm django python manage.py shell` |
| Open `psql` on the database | `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` |
| Open `redis-cli` | `docker compose exec redis redis-cli` |
| Open bash in the running web container | `docker compose exec django /entrypoint bash` |
| Stop everything, keep the data | `docker compose down` |

Use `run --rm` or `exec … /entrypoint …` for anything that touches the database. A bare `docker compose exec django python manage.py …` skips the image's entrypoint, which is what gives Django its database address, and fails with "connection refused".

The app's own log files are in the `production_django_logs` volume: `quran.log` from the web process, `worker.log` from the worker, and one file per run under `runs/`.

## Settings worth knowing

| Setting | Where | Default | What it does |
|---|---|---|---|
| `JOB_WORKER_SLOTS` | `.envs/.production/.django` | 2 | Jobs that run at once. The engines are CPU-bound: keep it at or under the number of CPU cores. Restart `django` and `celeryworker` after a change |
| `MAX_ACTIVE_JOBS_PER_USER` | the same file | 1 | Jobs one user may have queued or running |
| `MAX_QUEUED_JOBS` | the same file | 20 | Jobs that may wait for a slot |
| `GUNICORN_WORKERS`, `GUNICORN_THREADS` | the same file | 3, 4 | The web server's processes, and threads in each |
| `client_max_body_size` | `compose/production/nginx/default.conf` | `2g` | The largest upload nginx lets through. The app has no limit of its own. Rebuild `nginx` after a change |
| `proxy_read_timeout` | the same file | `300s` | How long nginx waits for Django. Exports and bundles are the slow requests |
| `stop_grace_period` | `docker-compose.production.yml`, `celeryworker` | `10m` | How long a stopping worker may wait for a job to reach its next page |

After editing an env file, recreate the services that read it:

```bash
docker compose up -d --force-recreate django celeryworker
```

## Upgrading Postgres to a new major version

The image is pinned to one major version in `compose/production/postgres/Dockerfile`, and a newer major cannot read the old data folder. To move up:

1. Back up with the old image: `docker compose exec postgres backup before_upgrade.dump`, and copy the dump off the server.
2. Stop the stack: `docker compose down`.
3. Change the version in the Dockerfile and rebuild: `docker compose build postgres`.
4. Remove the old data volume. **Only after step 1 worked**: `docker volume rm <project>_production_postgres_data` (`docker volume ls` shows the full name).
5. Start Postgres, restore, migrate: the three commands of [Moving your data to the server](#moving-your-data-to-the-server), with `before_upgrade.dump`.

## What was not tested

The images were built and the stack was started in the cloud, on Linux, without a public domain. So these are untested:

- **The certificate.** Traefik asking Let's Encrypt for a certificate, and renewing it. It needs a real domain that points at the server.
- **A real mushaf.** Uploading a PDF of real size through Traefik and nginx, and a whole-mushaf run in the worker.
- **A deploy over a running stack**, with a job in flight.
- **Email and Google sign-in** from the production domain.

[docs/CELERY_DOCKER_HANDOFF.md](docs/CELERY_DOCKER_HANDOFF.md) lists what was checked, and how.

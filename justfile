# Commands for the local Docker stack (docker-compose.local.yml).
# `just` alone lists them. Production is deployed by hand: see DEPLOY.md.

export COMPOSE_FILE := "docker-compose.local.yml"
# The containers run as you, so the files they write under backend/ belong to you.
export HOST_UID := `id -u`
export HOST_GID := `id -g`

# List the recipes.
default:
    @just --list --unsorted

# Build the images. Needed once, and again when backend/uv.lock changes.
build *args:
    docker compose build {{args}}

# Start Django, the worker, Postgres and Redis in the background.
up:
    docker compose up -d --remove-orphans

# Stop the stack. The database is kept.
down:
    docker compose down

# Stop the stack and DELETE its volumes: the database is gone.
prune *args:
    docker compose down -v {{args}}

# Follow the logs of every service, or of the ones named: `just logs celeryworker`.
logs *args:
    docker compose logs -f {{args}}

# Run a manage.py command: `just manage migrate`, `just manage shell`.
manage +args:
    docker compose run --rm django python manage.py {{args}}

# `exec` starts a command without the image's entrypoint, and the entrypoint is what
# sets DATABASE_URL. Without it, manage.py would read the localhost address in
# backend/.env and find no database there. So the shell is started through it.

# Open bash inside the django container.
shell:
    docker compose exec django /entrypoint bash

# Open psql inside the postgres container, as the right user on the right database.
psql:
    docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# Open redis-cli inside the redis container.
redis-cli:
    docker compose exec redis redis-cli

# Run npm in frontend/, on the host: `just npm run dev`, `just npm install`.
npm *args:
    cd frontend && npm {{args}}

# The backend's static checks, inside the django container. Both run, even when the first one fails.
check:
    docker compose run --rm django sh -c 'ruff check .; ruff=$?; python -m mypy .; mypy=$?; exit $((ruff + mypy))'

# The frontend's static checks, on the host.
check-frontend:
    cd frontend && npx tsc --noEmit && npm run lint

# The tests get threads and an in-memory cache, not the stack's worker and Redis: a
# test must never send a job to the real worker, and never count against the real
# rate limits.

# The backend tests, inside the django container: `just test`, `just test api.tests.test_job_queue`.
test *args:
    docker compose run --rm -e JOB_RUNNER=thread -e CACHE_URL=locmemcache:// django python manage.py test --parallel 4 {{args}}

# Dump the database to a file on the host: `just dump-db quran.dump`.
dump-db file:
    docker compose exec postgres backup transfer.dump
    docker compose cp postgres:/backups/transfer.dump "{{file}}"

# REPLACE the database with a dump (`pg_dump -Fc`), then migrate it: `just restore-db quran.dump`.
restore-db file:
    docker compose cp "{{file}}" postgres:/backups/transfer.dump
    docker compose exec postgres restore transfer.dump
    docker compose run --rm django python manage.py migrate

# Start Flower, a page that shows the worker and its tasks: http://localhost:5555
flower:
    docker compose --profile tools up -d flower

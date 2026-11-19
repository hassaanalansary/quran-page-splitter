# The production image of the backend. The web server and the Celery worker both
# run from it, with a different start script each.

# Build stage: the dependencies, installed into /app/.venv.
FROM docker.io/python:3.13.13-slim-bookworm AS python-build-stage

# uv, pinned by number, copied out of its own image.
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0

WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev
# .dockerignore keeps backend/.env, media and logs out of this copy.
COPY ./backend /app


# Run stage: the same base image, so the virtualenv's Python is in the same place.
# No uv, no compilers, no build tools.
FROM docker.io/python:3.13.13-slim-bookworm AS python-run-stage

WORKDIR /app
RUN addgroup --system django && adduser --system --ingroup django django

COPY --chown=django:django ./compose/production/django/entrypoint /entrypoint
COPY --chown=django:django ./compose/production/django/start /start
COPY --chown=django:django ./compose/production/django/celery/worker/start /start-celeryworker
RUN sed -i 's/\r$//g' /entrypoint /start /start-celeryworker \
  && chmod +x /entrypoint /start /start-celeryworker

COPY --from=python-build-stage --chown=django:django /app /app

# Docker fills a new volume from the folder it is mounted on. These folders must
# belong to the user the container runs as, or every upload fails.
RUN mkdir -p /app/media /app/logs /app/staticfiles \
  && chown django:django /app /app/media /app/logs /app/staticfiles

ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1

# Fail the build, not the first request, if a system library is missing.
RUN python -c "import cv2, fitz, psycopg"

USER django
ENTRYPOINT ["/entrypoint"]

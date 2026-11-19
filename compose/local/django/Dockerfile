# The image for local work: Python and every dependency, the dev group included.
# The source is not in the image. docker-compose.local.yml mounts the checkout at
# /app, so a change on disk is a change in the container.
FROM docker.io/python:3.13.13-slim-bookworm

# uv, pinned by number, copied out of its own image.
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /bin/uv

# The virtualenv lives at /venv, outside /app: the mounted checkout never hides it,
# and no .venv is ever written into the checkout.
ENV UV_PROJECT_ENVIRONMENT=/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    PATH="/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project

# Fail the build, not the first request, if a system library is missing.
RUN python -c "import cv2, fitz, psycopg"

COPY ./compose/production/django/entrypoint /entrypoint
COPY ./compose/local/django/start /start
COPY ./compose/local/django/celery/worker/start /start-celeryworker
RUN sed -i 's/\r$//g' /entrypoint /start /start-celeryworker \
  && chmod +x /entrypoint /start /start-celeryworker

ENTRYPOINT ["/entrypoint"]

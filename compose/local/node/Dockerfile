# Vite in a container. Only for `docker compose --profile frontend up`: the usual
# way is `npm run dev` on the host, which reloads faster.
FROM docker.io/node:24.22.2-bookworm-slim

WORKDIR /app/frontend
COPY ./frontend/package.json ./frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# The source itself comes from the mounted checkout (docker-compose.local.yml).
ENV PATH="/app/frontend/node_modules/.bin:$PATH"

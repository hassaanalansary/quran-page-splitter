# nginx with the built React app inside. It serves the app and /media, and passes
# everything that is Django's on to the django service (default.conf).

# Build the React app. Only its static files reach the final image.
FROM docker.io/node:24.22.2-bookworm-slim AS frontend-build-stage
WORKDIR /app/frontend
COPY ./frontend/package.json ./frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ./frontend ./
RUN npm run build

FROM docker.io/nginx:1.30.6-alpine
COPY ./compose/production/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build-stage /app/frontend/dist /usr/share/nginx/html

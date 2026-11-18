# Postgres, pinned to one major version, with the backup and restore scripts of
# ./maintenance on its PATH. Local and production both run this image.
#
# A new major version needs its data moved: dump with the old image, restore
# into the new one (DEPLOY.md).
FROM docker.io/postgres:18

COPY ./compose/production/postgres/maintenance /usr/local/bin/maintenance
RUN sed -i 's/\r$//g' /usr/local/bin/maintenance/* \
  && chmod +x /usr/local/bin/maintenance/* \
  && mv /usr/local/bin/maintenance/* /usr/local/bin \
  && rmdir /usr/local/bin/maintenance

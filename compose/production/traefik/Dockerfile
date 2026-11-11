# Traefik: the only container that listens on the server's ports 80 and 443. It
# gets the certificate from Let's Encrypt and passes every request on to nginx.
FROM docker.io/traefik:v3.7.10
RUN mkdir -p /etc/traefik/acme \
  && touch /etc/traefik/acme/acme.json \
  && chmod 600 /etc/traefik/acme/acme.json
COPY ./compose/production/traefik/dynamic.yml /etc/traefik/dynamic.yml

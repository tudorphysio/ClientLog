FROM caddy:2-alpine
WORKDIR /srv
COPY index.html /srv/index.html
CMD ["sh", "-c", "caddy file-server --root /srv --listen :${PORT:-8080}"]

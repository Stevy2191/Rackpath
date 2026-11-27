# Rackpath v2: one small binary serving the web app and the API, with its
# database in a single SQLite file. No database server, no web server.
#
#   docker build -t rackpath .
#   docker run -p 8080:8080 -v rackpath-data:/data \
#     -e RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32) rackpath

# The web app (static files).
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# The server.
FROM rust:1.94-slim-bookworm AS build
WORKDIR /src
COPY api-rs/Cargo.toml api-rs/Cargo.lock ./
COPY api-rs/migrations ./migrations
COPY api-rs/src ./src
RUN cargo build --release --locked \
    && mkdir -p /data-template

# Distroless: no shell or package manager, runs as an unprivileged user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/rackpath /usr/local/bin/rackpath
COPY --from=web /web/dist /app/web
# A named volume takes its ownership from the image, so /data must exist and
# belong to the unprivileged user (uid 65532) for the database to be created.
COPY --from=build --chown=65532:65532 /data-template /data
ENV RACKPATH_DATA_DIR=/data \
    RACKPATH_WEB_DIR=/app/web \
    RACKPATH_BIND=0.0.0.0:8080
VOLUME ["/data"]
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/rackpath"]
CMD ["serve"]

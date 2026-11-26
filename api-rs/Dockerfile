# Rackpath v2 API: one small binary, no database server.
#
#   docker build -t rackpath-v2 api-rs
#   docker run -p 8080:8080 -v rackpath-data:/data \
#     -e RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32) rackpath-v2

FROM rust:1.94-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked \
    && mkdir -p /data-template

# Distroless: no shell or package manager, runs as an unprivileged user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/rackpath /usr/local/bin/rackpath
# A named volume takes its ownership from the image, so /data must exist and
# belong to the unprivileged user (uid 65532) for the database to be created.
COPY --from=build --chown=65532:65532 /data-template /data
ENV RACKPATH_DATA_DIR=/data \
    RACKPATH_BIND=0.0.0.0:8080
VOLUME ["/data"]
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/rackpath"]
CMD ["serve"]

# syntax=docker/dockerfile:1.7
FROM rust:1.83-slim-bookworm AS builder
WORKDIR /app

# Install build deps for reqwest (rustls requires no openssl, but curl/git for cargo registry)
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Cache dependencies first by copying only manifests and a dummy lib.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release && rm -rf src target/release/starquake-server target/release/deps/starquake_server*

# Real build
COPY src ./src
COPY data ./data
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/starquake-server /usr/local/bin/starquake-server
EXPOSE 8080
CMD ["starquake-server"]

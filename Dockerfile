FROM rust:1-bookworm AS builder

WORKDIR /app

COPY Cargo.toml ./
COPY src ./src

RUN cargo --version && rustc --version && cargo build --release


FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/rust-shield /usr/local/bin/rust-shield

ENV RUST_SHIELD_HOST=0.0.0.0
ENV RUST_SHIELD_PORT=8787
ENV RUST_LOG=info

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD /usr/local/bin/rust-shield healthcheck || exit 1

ENTRYPOINT ["/usr/local/bin/rust-shield"]

FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/rust-shield /usr/local/bin/rust-shield
ENV RUST_SHIELD_BIND=0.0.0.0:8787 \
    RUST_LOG=info
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD ["/usr/local/bin/rust-shield", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/rust-shield"]

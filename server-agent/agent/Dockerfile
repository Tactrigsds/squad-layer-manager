# Build context is this directory (server-agent/agent):
# docker build -t slm-server-agent server-agent/agent
#
# Runtime config is by env (see --help / src/main.rs): SLM_URL, SLM_SERVER_ID, SLM_TOKEN, SLM_LOG_PATH, and
# optionally SLM_RCON_HOST / SLM_RCON_PORT / SLM_RCON_PASSWORD to proxy RCON. Mount the squad server's log
# directory and point SLM_LOG_PATH at the SquadGame.log inside it, e.g.
# docker run --rm -v /srv/squad/SquadGame/Saved/Logs:/logs:ro \
# -e SLM_URL=wss://slm.example.com/server-agent -e SLM_SERVER_ID=srv1 -e SLM_TOKEN=... \
# -e SLM_LOG_PATH=/logs/SquadGame.log slm-server-agent

FROM rust:1-slim AS build
WORKDIR /agent
# musl-tools provides musl-gcc; the trust roots are compiled in (webpki-roots), so the runtime needs no
# ca-certificates and the crypto backend is ring, so there's no cmake/C dependency to install here
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl

# ring compiles a little C for the musl target, and cc-rs/the linker look for a musl-prefixed gcc; point
# both at the musl-gcc that musl-tools provides
ENV CC_x86_64_unknown_linux_musl=musl-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --target x86_64-unknown-linux-musl

# static musl binary: needs no libc, so a minimal base is enough. distroless/static ships CA certs,
# /etc/passwd and a nonroot user, which is all a network client wants.
FROM gcr.io/distroless/static-debian12 AS runtime
COPY --from=build /agent/target/x86_64-unknown-linux-musl/release/slm-server-agent /usr/local/bin/slm-server-agent
USER nonroot
ENTRYPOINT ["/usr/local/bin/slm-server-agent"]

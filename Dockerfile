# Engine stage - compile the layer query engine to wasm. One artifact serves both the browser worker and the server.
FROM rust:1.90-slim AS layer-engine
WORKDIR /layer-engine
RUN rustup target add wasm32-unknown-unknown
COPY layer-engine/Cargo.toml layer-engine/rust-toolchain.toml ./
COPY layer-engine/src ./src
RUN cargo build --release --target wasm32-unknown-unknown

# Build stage - compile frontend and backend
FROM node:24.18.0 AS builder
LABEL org.opencontainers.image.description="A squad server admin tool focused on managing upcoming layers"
LABEL org.opencontainers.image.source="https://github.com/tactrigsds/squad-layer-manager"

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install all dependencies (including devDependencies for build)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy source code
COPY . .

# the worker bundles the engine wasm as an asset, so it has to exist before the client build
COPY --from=layer-engine /layer-engine/target/wasm32-unknown-unknown/release/layer_engine.wasm ./assets/layer-engine.wasm

# Set build environment
ENV NODE_ENV=production

# Build frontend and backend
RUN pnpm run build:prod

# Runtime stage - minimal production image
FROM node:24.18.0-slim AS runtime

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Install build dependencies for native modules (better-sqlite3, etc.). libjemalloc2 is not one of them;
# see the LD_PRELOAD below.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

# Run on jemalloc rather than glibc malloc. glibc hands each allocating thread its own arena and then
# essentially never returns freed pages to the OS, so RSS ratchets to the high-water mark and stays there:
# taking one heap snapshot of a 570MB process left it at 1.37GB with the JS heap unchanged. jemalloc decays
# unused pages back instead. Set as an image env rather than in docker-compose.yaml so every deployment gets
# it without knowing this path exists. amd64 -- an arm64 build needs /usr/lib/aarch64-linux-gnu/.
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

RUN corepack enable
RUN mkdir -p /logs

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install production dependencies (external deps + migration tools)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

# Registers the OTel import-in-the-middle loader hook; `server:prod` loads it via `node --import`.
# Without it the auto-instrumentations load but patch nothing (see register-otel.mjs).
COPY --from=builder /app/register-otel.mjs ./register-otel.mjs

# the server instantiates the same engine the browser does, and reads the wasm off disk
COPY --from=builder /app/assets/layer-engine.wasm ./assets/layer-engine.wasm

# the layer table and the components its encoded values index into. Small enough to ship, so the image boots on
# its own; a deployment that wants a different layer version drops the pair into its /app/data mount, which is
# searched first (see systems/layer-artifacts.server.ts).
COPY --from=builder /app/assets/layers ./assets/layers

# Copy necessary runtime files
COPY --from=builder /app/drizzle-sqlite ./drizzle-sqlite
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Set runtime environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

ARG GIT_SHA="unknown"
ARG GIT_BRANCH="unknown"
ENV PUBLIC_GIT_SHA=${GIT_SHA}
ENV PUBLIC_GIT_BRANCH=${GIT_BRANCH}

# Run the server using the compiled output
CMD ["pnpm", "run", "server:prod"]

# Test stage - the production image, plus the machinery to drive it.
#
# Deliberately built on top of `runtime` rather than beside it: the tests spawn the very server
# bundle that gets deployed (SLM_TEST_SERVER_ENTRY below), against the same dist/ the browser loads,
# so what CI exercises is the artifact, not a re-derivation of it. What's added is only what a test
# needs and production must not carry: dev dependencies, a browser, and the test sources.
FROM runtime AS test

# before the install: the runtime stage sets NODE_ENV=production, and pnpm skips devDependencies when
# it sees that -- which is every tool the tests are made of
ENV NODE_ENV=test

# the tests import app source (models, the emulator) and are TypeScript, so the source tree and the
# dev dependencies come back
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod=false

COPY src ./src
COPY test ./test
COPY drizzle ./drizzle
COPY paths.ts tsconfig.json tsconfig.paths.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts vitest.integration.config.ts playwright.config.ts index.html ./

# Only the headless shell, not the full chromium: `playwright install chromium` fetches both (646MB),
# and the shell alone (267MB) is what a headless run uses. --with-deps brings in the system libraries
# it links against.
RUN pnpm exec playwright install --with-deps chromium-headless-shell

# drive the deployed bundle rather than the source: the point of testing in this image is that it is
# the image
ENV SLM_TEST_SERVER_ENTRY=dist-server/main-instrumented.js
# nothing to mount: the layer artifacts the tests run against are the ones baked into the runtime stage,
# which are the ones production runs.

CMD ["pnpm", "run", "test:ci"]

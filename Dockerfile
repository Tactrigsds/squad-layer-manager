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

# Set build environment
ENV NODE_ENV=production

# Build frontend and backend
RUN pnpm run build:prod

# Runtime stage - minimal production image
FROM node:24.18.0-slim AS runtime

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Install build dependencies for native modules (better-sqlite3, etc.)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

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
COPY paths.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts vitest.integration.config.ts playwright.config.ts index.html ./

# Only the headless shell, not the full chromium: `playwright install chromium` fetches both (646MB),
# and the shell alone (267MB) is what a headless run uses. --with-deps brings in the system libraries
# it links against.
RUN pnpm exec playwright install --with-deps chromium-headless-shell

# drive the deployed bundle rather than the source: the point of testing in this image is that it is
# the image
ENV SLM_TEST_SERVER_ENTRY=dist-server/main-instrumented.js
# the layer db is not baked in (it isn't in production either); mount /app/data, as the deployment does
ENV LAYERS_DB_PATH=/app/data/layers_v{{LAYERS_VERSION}}.sqlite3.gz

CMD ["pnpm", "run", "test:ci"]

# Build stage - compile frontend and backend
FROM node:lts AS builder
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
FROM node:lts-slim AS runtime

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

# Install production dependencies (runtime + migration tools)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

# Copy necessary runtime files
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Set runtime environment
ARG GIT_SHA="unknown"
ARG GIT_BRANCH="unknown"
ENV PUBLIC_GIT_SHA=${GIT_SHA}
ENV PUBLIC_GIT_BRANCH=${GIT_BRANCH}
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Run the server using the compiled output
CMD ["pnpm", "run", "server:prod"]

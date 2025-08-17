FROM node:lts AS base
LABEL org.opencontainers.image.description="Squad Layer Manager. See https://github.com/Tactrigsds/squad-layer-manager"

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN mkdir -p /logs

RUN corepack enable
WORKDIR /app
COPY package.json .
COPY pnpm-lock.yaml .
COPY pnpm-workspace.yaml .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
ARG GIT_SHA="unknown"
ARG GIT_BRANCH="unknown"
ARG TYPECHECK_AND_FORMAT
ENV PUBLIC_GIT_SHA=${GIT_SHA}
ENV PUBLIC_GIT_BRANCH=${GIT_BRANCH}
ENV NODE_ENV=production
RUN if [ -n "$TYPECHECK_AND_FORMAT" ]; then \
    pnpm run check & \
    pnpm run format:check & \
    wait; \
    fi
RUN pnpm vite build

ENV HOST=0.0.0.0
ENV PORT=3000
CMD ["pnpm", "run", "server:prod"]

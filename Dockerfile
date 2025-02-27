ARG GIT_SHA
ARG GIT_BRANCH

FROM node:lts AS base
LABEL org.opencontainers.image.description "Squad Layer Manager. See https://github.com/Tactrigsds/squad-layer-manager"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update && apt-get install -y logrotate && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /logs

RUN corepack enable
WORKDIR /app
COPY package.json .
COPY pnpm-lock.yaml .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
COPY ./docker/logrotate.conf /etc/logrotate.d/app
ENV GIT_SHA=$GIT_SHA
ENV GIT_BRANCH=$GIT_BRANCH
ENV NODE_ENV=production
RUN pnpm vite build

ENV HOST=0.0.0.0
ENV PORT=3000
CMD ["pnpm", "run", "server:prod"]

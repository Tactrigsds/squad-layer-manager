FROM node:lts AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update && apt-get install -y logrotate && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json /app/
COPY pnpm-lock.yaml /app/
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm vite build

FROM base
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/docker ./docker
# public dir empty right now
# COPY --from=build /app/public ./public
COPY --from=build /app/assets ./assets
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle.config.ts ./
COPY --from=build /app/vitest.config.ts ./
COPY --from=build /app/tsconfig.*.json ./
COPY --from=build /app/docker/logrotate.conf /etc/logrotate.d/app
RUN mkdir -p /logs
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV PROD_LOG_PATH=/logs/app.jsonl
CMD ["pnpm", "run", "server:prod"]

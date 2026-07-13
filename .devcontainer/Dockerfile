# Dev container image. Node is pinned to the same version the production Dockerfile and
# .tool-versions use, so a native module that builds here builds there.
FROM node:24.18.0-bookworm

# node-gyp compiles the native deps (better-sqlite3, cpu-features, bufferutil, utf-8-validate) and
# needs python3; the base image already carries gcc/g++/make from buildpack-deps. fish is available for
# anyone who wants it, but bash stays the default shell.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 fish \
	&& rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The store has to be pinned somewhere outside the workspace. pnpm's default is under $HOME, but it
# only uses that when $HOME and the project are on the same filesystem -- and node_modules is a volume
# here, so it isn't. Left alone, pnpm falls back to <project>/.pnpm-store, which is the bind mount:
# the store would land in the host's repo.
ENV NPM_CONFIG_STORE_DIR="/pnpm/store"
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate \
	&& mkdir -p "$NPM_CONFIG_STORE_DIR" && chown -R node:node "$PNPM_HOME"

# Browsers live outside the workspace so they survive the node_modules volume and image rebuilds, and
# so `pnpm exec playwright install` in post-create is a no-op rather than a 400MB download. The version
# must track @playwright/test in package.json: if it drifts, playwright wants a browser build that
# isn't here and post-create fetches the right one into this directory instead.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.61.1 install --with-deps chromium \
	&& chown -R node:node /ms-playwright

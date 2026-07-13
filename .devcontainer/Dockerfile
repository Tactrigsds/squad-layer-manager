# Dev container image. Node is pinned to the same version the production Dockerfile and
# .tool-versions use, so a native module that builds here builds there.
FROM node:24.18.0-bookworm

# python3: node-gyp compiles the native deps (better-sqlite3, cpu-features, bufferutil, utf-8-validate)
# and needs it; the base image already carries gcc/g++/make from buildpack-deps.
# sqlite3, jq, vim: edit-global-settings.sh shells out to all three ($EDITOR defaults to vim), and
# sqlite3 is how you go poke at data/main.sqlite3 by hand anyway.
# less: git's pager.
# ripgrep, fd, tree, bat, lsof: what a coding agent (or a human) reaches for -- search, file listing,
# and finding out who is holding a port.
# fish is available for anyone who wants it, but bash stays the default shell.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		python3 sqlite3 jq vim less \
		ripgrep fd-find tree bat lsof \
		fish \
	&& rm -rf /var/lib/apt/lists/* \
# debian ships these two under different names to avoid collisions; everything (and everyone)
# expects them as `fd` and `bat`
	&& ln -s "$(command -v fdfind)" /usr/local/bin/fd \
	&& ln -s "$(command -v batcat)" /usr/local/bin/bat

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The store has to be pinned somewhere outside the workspace. pnpm's default is under $HOME, but it
# only uses that when $HOME and the project are on the same filesystem -- and node_modules is a volume
# here, so it isn't. Left alone, pnpm falls back to <project>/.pnpm-store, which is the bind mount:
# the store would land in the host's repo.
ENV NPM_CONFIG_STORE_DIR="/pnpm/store"
# Corepack caches the package manager it downloads under $HOME, and this build runs as root while the
# container runs as `node`. Left at the default, root's cache is primed and node's is empty, so corepack
# re-fetches pnpm from the registry the first time you run any pnpm command -- turning `pnpm run
# server:dev` into something that needs the network, and failing outright when it can't reach npmjs.
# A shared COREPACK_HOME bakes pnpm into the image for every user.
ENV COREPACK_HOME="/pnpm/corepack"
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate \
	&& mkdir -p "$NPM_CONFIG_STORE_DIR" && chown -R node:node "$PNPM_HOME"

# Browsers live outside the workspace so they survive the node_modules volume and image rebuilds, and
# so `pnpm exec playwright install` in post-create is a no-op rather than a 400MB download. The version
# must track @playwright/test in package.json: if it drifts, playwright wants a browser build that
# isn't here and post-create fetches the right one into this directory instead.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.61.1 install --with-deps chromium \
	&& chown -R node:node /ms-playwright

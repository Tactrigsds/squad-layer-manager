# Dev container image. The toolchain is nix/flake.nix's `devcontainer-tools`, built in a throwaway nix stage and copied
# in as a plain store closure, so the image needs no nix at runtime and pins the same node as the flake. The build
# context is nix/ (see devcontainer.json).
FROM nixos/nix:2.35.2 AS tools
COPY flake.nix flake.lock /flake/
# docker build offers no user namespaces for nix's sandbox, and everything here is a cache substitution or a buildEnv
# of symlinks anyway
RUN nix --extra-experimental-features 'nix-command flakes' --option sandbox false --option filter-syscalls false \
		build 'path:/flake#devcontainer-tools' --out-link /tools \
	&& mkdir /closure \
	&& cp -a $(nix-store --query --requisites /tools) /closure/

# The devcontainers base image carries the `vscode` user with passwordless sudo, git and the usual shell tooling.
FROM mcr.microsoft.com/devcontainers/base:2-bookworm
COPY --from=tools /closure /nix/store
RUN ln -s /nix/store/*-slm-devcontainer-tools /opt/slm-tools
ENV PATH="/opt/slm-tools/bin:$PATH"

# sqlite3, jq, vim: edit-global-settings.sh shells out to all three ($EDITOR defaults to vim), and sqlite3 is how you
# go poke at data/main.sqlite3 by hand anyway.
# ripgrep, fd, tree, bat, lsof: what a coding agent (or a human) reaches for -- search, file listing, and finding out
# who is holding a port.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		sqlite3 jq vim \
		ripgrep fd-find tree bat lsof \
	&& ln -s "$(command -v fdfind)" /usr/local/bin/fd \
	&& ln -s "$(command -v batcat)" /usr/local/bin/bat \
# The system libraries chromium needs. The browser itself is downloaded by post-create into the shared volume at
# PLAYWRIGHT_BROWSERS_PATH, since its version has to follow the @playwright/test in package.json.
	&& npx --yes playwright@1 install-deps chromium \
	&& rm -rf /var/lib/apt/lists/* /root/.npm

# corepack writes its shims beside the node binary by default, which is the read-only store. COREPACK_HOME is shared
# so the pnpm that post-create fetches serves every user.
ENV COREPACK_HOME="/pnpm/corepack"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The store has to be pinned somewhere outside the workspace. pnpm's default is under $HOME, but it only uses that when
# $HOME and the project are on the same filesystem -- and node_modules is a volume here, so it isn't. Left alone,
# pnpm falls back to <project>/.pnpm-store, which is the bind mount: the store would land in the host's repo.
ENV NPM_CONFIG_STORE_DIR="/pnpm/store"
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable --install-directory /usr/local/bin \
	&& mkdir -p "$COREPACK_HOME" "$NPM_CONFIG_STORE_DIR" "$PLAYWRIGHT_BROWSERS_PATH" \
	&& chown -R vscode:vscode "$PNPM_HOME" "$PLAYWRIGHT_BROWSERS_PATH" \
# debian's /etc/profile resets PATH, which drops the ENV above in every login shell
	&& echo 'export PATH="/opt/slm-tools/bin:$PNPM_HOME:$PATH"' > /etc/profile.d/slm-tools.sh

#!/usr/bin/env bash
# Runs once, after the container is created. Everything here is either something a volume mount broke (ownership) or
# something the image can't carry (the install, the browser build package.json pins, and the gitignored engine).
set -euo pipefail

# docker creates named volumes owned by root
sudo chown -R vscode:vscode node_modules "$NPM_CONFIG_STORE_DIR" "$PLAYWRIGHT_BROWSERS_PATH" 2> /dev/null || true

# fetches the pnpm that package.json's `packageManager` names into COREPACK_HOME
corepack install
pnpm install --frozen-lockfile
# a no-op when another container already downloaded this build into the shared volume
pnpm exec playwright install chromium

[[ -f assets/layer-engine.wasm ]] || pnpm run build:engine

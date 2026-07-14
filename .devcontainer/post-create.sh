#!/usr/bin/env bash
# Runs once, after the container is created. Everything here is either something a volume mount broke
# (ownership) or something the image can't carry (the install, and the two artifacts that are
# gitignored because they're secret or generated).
set -euo pipefail

# docker creates named volumes owned by root; pnpm writes to both as `node`
sudo chown -R node:node node_modules "$NPM_CONFIG_STORE_DIR" 2>/dev/null || true

pnpm install --frozen-lockfile

# no-op when the browser baked into the image is the one @playwright/test wants, a download when the
# pinned version in .devcontainer/Dockerfile has drifted from package.json
pnpm exec playwright install chromium

missing=()
[[ -f .env ]] || missing+=(".env  -- secrets and local overrides; see src/server/env.ts for the schema. The container has no copy and cannot generate one.")
# the layer query engine is a rust crate compiled to wasm; the app can't build or boot without it
if command -v cargo > /dev/null; then
	pnpm run build:engine
else
	missing+=("assets/layer-engine.wasm  -- the layer query engine. Install rust, then run \`pnpm build:engine\`.")
fi

# preprocess writes both, and they're published together: the table the engine reads, and the components that give
# its encoded values meaning. One without the other is useless.
compgen -G "data/layers_v*.bin.gz" > /dev/null \
	|| missing+=("data/layers_v*.bin.gz  -- the layer table, generated. Run \`pnpm preprocess\` (needs network).")
[[ -f data/layer-data.json ]] \
	|| missing+=("data/layer-data.json  -- the layer components, generated. Run \`pnpm preprocess\` (needs network).")

if (( ${#missing[@]} )); then
	echo
	echo "Dev container is built, but the app won't boot until these exist in the workspace:"
	printf '  - %s\n' "${missing[@]}"
fi

cat <<'EOF'

Ready. Notes specific to running in here:
  - `pnpm client:dev --host`  the --host is needed: vite binds to localhost otherwise, which is not
                              reachable from your machine through the container's published ports.
  - `pnpm server:dev`         already binds 0.0.0.0 (HOST is set in devcontainer.json).
  - otel / the CI-parity test image run on the HOST, not in here (this container has no docker).
    `docker compose up -d otel` on the host and the app in here will export to it; grafana stays at
    localhost:3001 on the host.
EOF
